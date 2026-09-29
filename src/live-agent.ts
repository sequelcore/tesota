import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_FIX_CASES, AGENT_QUESTIONS, QUESTION_REPOSITORY, allowedCommand, factsStated, productionChanges,
  quantile, wordCount } from "./agent-evaluation.js";
import { hostProvider } from "./host-environment.js";
import { openModelTarget, startWorkingAgent } from "./integrations/model-session.js";
import { readModelChoices } from "./model-roles.js";
import { type TokenUsage, totalTokens } from "./token-usage.js";

/**
 * Run the working agent's evaluation for issue #165 live and write one JSON
 * record under live-runs/agent/. Each request and question goes to a fresh
 * agent with Tesota's own prompt, in a fresh Git repository, so a prompt
 * change is measured by running this before and after it. The agent may run
 * only Node's test runner; a hidden test, run afterwards, decides a fix.
 *
 *   bun run live:agent [--runs=N] [--model-agent=<id>]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(option("runs") ?? "2");
if (!Number.isInteger(runs) || runs < 1) throw new Error("Use --runs=N with N at least 1.");
const agentId = option("model-agent") ?? readModelChoices().agent;
const target = await openModelTarget(agentId);
const root = mkdtempSync(join(tmpdir(), "tesota-agent-eval-"));

function repository(name: string, files: Readonly<Record<string, string>>): string {
  const directory = join(root, `${name.replaceAll(" ", "-")}-${randomUUID().slice(0, 8)}`);
  for (const [path, text] of Object.entries({ ...files, "package.json": JSON.stringify({ type: "module" }) })) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  const git = (args: string[]): void => { spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: directory }); };
  git(["init", "-q"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  return directory;
}

function changedPaths(directory: string): string[] {
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: directory, encoding: "utf8" });
  return status.stdout.split("\n").filter((line) => line.length > 3).map((line) => line.slice(3).trim());
}

interface Turn { readonly status: string; readonly reply: string; readonly tokens: number; readonly durationMs: number; readonly commands: string[] }

async function ask(directory: string, request: string): Promise<Turn> {
  let tokens = 0;
  const commands: string[] = [];
  const session = await startWorkingAgent({ target, onUsage: (usage: TokenUsage) => { tokens += totalTokens(usage); } },
    { cwd: directory, environment: await hostProvider.prepare(directory), sandboxed: false,
      approveCommand: async ({ command }) => { commands.push(command); return allowedCommand(command) ? "once" : "deny"; } },
    { conversationId: randomUUID() });
  const started = Date.now();
  try {
    const turn = await session.run(request, AbortSignal.timeout(15 * 60_000));
    return { status: turn.status, reply: turn.status === "completed" ? turn.reply : "", tokens, durationMs: Date.now() - started, commands };
  } finally { session.dispose(); }
}

const fixes: unknown[] = [];
const answers: { question: string; run: number; words: number; stated: number; facts: number; changed: string[]; turn: Turn }[] = [];
const outcome: Record<string, { attempts: number; resolved: number; untouched: number }> = {};
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const testCase of AGENT_FIX_CASES) {
      const directory = repository(testCase.name, testCase.base);
      const turn = await ask(directory, testCase.request);
      const changed = changedPaths(directory);
      const production = productionChanges(changed);
      mkdirSync(join(directory, ".hidden"), { recursive: true });
      writeFileSync(join(directory, ".hidden", "check.test.js"), testCase.hiddenTest);
      const resolved = spawnSync("node", ["--test", ".hidden/check.test.js"], { cwd: directory, encoding: "utf8" }).status === 0;
      const tally = outcome[testCase.kind] ??= { attempts: 0, resolved: 0, untouched: 0 };
      tally.attempts += 1;
      tally.resolved += resolved ? 1 : 0;
      tally.untouched += production.length === 0 ? 1 : 0;
      fixes.push({ name: testCase.name, kind: testCase.kind, run, resolved, changed, production, words: wordCount(turn.reply), turn });
      console.log(`run ${run} · ${testCase.name}: ${resolved ? "resolved" : "not resolved"}, ` +
        `${production.length === 0 ? "no production change" : `changed ${production.join(", ")}`}, ` +
        `${wordCount(turn.reply)} words, ${Math.round(turn.tokens / 1000)}k tokens` + (turn.status === "completed" ? "" : ` (${turn.status})`));
    }
    for (const entry of AGENT_QUESTIONS) {
      const directory = repository("questions", QUESTION_REPOSITORY);
      const turn = await ask(directory, entry.question);
      const words = wordCount(turn.reply);
      const stated = factsStated(entry.facts, turn.reply);
      answers.push({ question: entry.question, run, words, stated, facts: entry.facts.length, changed: changedPaths(directory), turn });
      console.log(`run ${run} · ${entry.question} ${words} words, ${stated}/${entry.facts.length} facts` +
        (turn.status === "completed" ? "" : ` (${turn.status})`));
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }

const words = answers.filter((entry) => entry.turn.status === "completed").map((entry) => entry.words);
const record = { at: new Date().toISOString(), model: agentId, runs,
  fixes: outcome,
  answers: { replies: words.length, unfinished: answers.length - words.length, medianWords: quantile(words, 0.5),
    p90Words: quantile(words, 0.9), stated: answers.reduce((sum, entry) => sum + entry.stated, 0),
    facts: answers.reduce((sum, entry) => sum + entry.facts, 0),
    changedFiles: answers.filter((entry) => entry.changed.length > 0).length },
  attempts: { fixes, answers } };
mkdirSync(join("live-runs", "agent"), { recursive: true });
const file = join("live-runs", "agent", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`fixes ${JSON.stringify(record.fixes)}\nanswers ${JSON.stringify(record.answers)}\nrecorded ${file}`);
