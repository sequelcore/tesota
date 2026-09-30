import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_FIX_CASES, AGENT_PREMISE_CASES, AGENT_QUESTIONS, AGENT_SCOPE_CASES, QUESTION_REPOSITORY, allowedCommand,
  beyondRequest, factsStated, mentions, premiseRight, productionChanges, quantile, wordCount } from "./agent-evaluation.js";
import { hostProvider } from "./host-environment.js";
import { openModelTarget, startWorkingAgent } from "./integrations/model-session.js";
import { readModelChoices } from "./model-roles.js";
import { type TokenUsage, totalTokens } from "./token-usage.js";

/**
 * Run the working agent's evaluation for issue #165 live and write one JSON
 * record under live-runs/agent/. Each request and question goes to a fresh
 * agent with Tesota's own prompt, in a fresh Git repository, so a prompt
 * change is measured by running this before and after it. The agent may run
 * only Node's test runner; a hidden test, run afterwards, decides a fix, and
 * for a scope case a preserved test and the case's allowed paths and kept code
 * decide whether it did only what was asked; for a premise case, whether it
 * left alone a request whose premise is false and fixed the control.
 *
 *   bun run live:agent [--runs=N] [--set=all|fixes|scope|premise|questions] [--model-agent=<id>]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(option("runs") ?? "2");
if (!Number.isInteger(runs) || runs < 1) throw new Error("Use --runs=N with N at least 1.");
const set = option("set") ?? "all";
if (!["all", "fixes", "scope", "premise", "questions"].includes(set)) {
  throw new Error("Use --set=all, fixes, scope, premise or questions.");
}
const includes = (part: string): boolean => set === "all" || set === part;
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
const scoped: unknown[] = [];
const scope = { attempts: 0, resolved: 0, inScope: 0, controlAttempts: 0, controlInScope: 0, mentionable: 0, mentioned: 0 };
const premised: unknown[] = [];
const premise = { attempts: 0, leftAlone: 0, reported: 0, controlAttempts: 0, controlResolved: 0 };
const passes = (directory: string, path: string, text: string): boolean => {
  mkdirSync(join(directory, ".hidden"), { recursive: true });
  writeFileSync(join(directory, ".hidden", path), text);
  return spawnSync("node", ["--test", `.hidden/${path}`], { cwd: directory, encoding: "utf8" }).status === 0;
};
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const testCase of includes("fixes") ? AGENT_FIX_CASES : []) {
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
    for (const testCase of includes("scope") ? AGENT_SCOPE_CASES : []) {
      const directory = repository(testCase.name, testCase.base);
      const turn = await ask(directory, testCase.request);
      const changed = changedPaths(directory);
      const beyond = beyondRequest(testCase, changed, (path) => {
        const file = join(directory, path);
        return existsSync(file) ? readFileSync(file, "utf8") : undefined;
      });
      const resolved = passes(directory, "check.test.js", testCase.hiddenTest);
      const preserved = passes(directory, "preserved.test.js", testCase.preserved);
      const inScope = beyond.outside.length === 0 && beyond.rewritten.length === 0 && preserved;
      const mentioned = testCase.mention.length > 0 && mentions(testCase, turn.reply);
      if (testCase.temptation === "control") {
        scope.controlAttempts += 1;
        scope.controlInScope += inScope && resolved ? 1 : 0;
      } else {
        scope.attempts += 1;
        scope.resolved += resolved ? 1 : 0;
        scope.inScope += inScope ? 1 : 0;
        scope.mentionable += testCase.mention.length > 0 ? 1 : 0;
        scope.mentioned += mentioned ? 1 : 0;
      }
      scoped.push({ name: testCase.name, temptation: testCase.temptation, run, resolved, preserved, inScope, mentioned, changed,
        ...beyond, words: wordCount(turn.reply), turn });
      console.log(`run ${run} · ${testCase.name}: ${resolved ? "resolved" : "not resolved"}, ` +
        `${inScope ? "in scope" : `beyond the request (${[...beyond.outside, ...beyond.rewritten.map((path) => `rewrote ${path}`),
          ...preserved ? [] : ["changed preserved behavior"]].join(", ")})`}` +
        `${testCase.mention.length > 0 ? `, ${mentioned ? "reported" : "did not report"} the temptation` : ""}, ` +
        `${Math.round(turn.tokens / 1000)}k tokens` + (turn.status === "completed" ? "" : ` (${turn.status})`));
    }
    for (const testCase of includes("premise") ? AGENT_PREMISE_CASES : []) {
      const directory = repository(testCase.name, testCase.base);
      const turn = await ask(directory, testCase.request);
      const changed = changedPaths(directory);
      const production = productionChanges(changed);
      const right = premiseRight(testCase, passes(directory, "check.test.js", testCase.hiddenTest), production);
      const reported = mentions(testCase, turn.reply);
      if (testCase.premise === "control") {
        premise.controlAttempts += 1;
        premise.controlResolved += right ? 1 : 0;
      } else {
        premise.attempts += 1;
        premise.leftAlone += right ? 1 : 0;
        premise.reported += reported ? 1 : 0;
      }
      premised.push({ name: testCase.name, premise: testCase.premise, run, right, reported, changed, production,
        words: wordCount(turn.reply), turn });
      const verdict = testCase.premise === "control" ? right ? "resolved" : "not resolved"
        : `${right ? "left alone" : `acted (${production.join(", ") || "changed the behavior"})`}, ` +
          `${reported ? "reported" : "did not report"} the premise`;
      console.log(`run ${run} · ${testCase.name}: ${verdict}, ${Math.round(turn.tokens / 1000)}k tokens` +
        (turn.status === "completed" ? "" : ` (${turn.status})`));
    }
    for (const entry of includes("questions") ? AGENT_QUESTIONS : []) {
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
const record = { at: new Date().toISOString(), model: agentId, runs, set,
  fixes: outcome, scope, premise,
  answers: { replies: words.length, unfinished: answers.length - words.length, medianWords: quantile(words, 0.5),
    p90Words: quantile(words, 0.9), stated: answers.reduce((sum, entry) => sum + entry.stated, 0),
    facts: answers.reduce((sum, entry) => sum + entry.facts, 0),
    changedFiles: answers.filter((entry) => entry.changed.length > 0).length },
  attempts: { fixes, scope: scoped, premise: premised, answers } };
mkdirSync(join("live-runs", "agent"), { recursive: true });
const file = join("live-runs", "agent", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`fixes ${JSON.stringify(record.fixes)}\nscope ${JSON.stringify(record.scope)}\npremise ${JSON.stringify(record.premise)}\n` +
  `answers ${JSON.stringify(record.answers)}\nrecorded ${file}`);
