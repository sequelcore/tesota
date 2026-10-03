import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AGENT_FIX_CASES, AGENT_PREMISE_CASES, AGENT_PROOF_CASES, AGENT_QUESTIONS, AGENT_SCOPE_CASES, AGENT_STRENGTHEN_CASES,
  QUESTION_REPOSITORY, allowedCommand, beyondRequest, contractWeakened, factsStated, mentions, premiseRight, productionChanges,
  quantile, withBuggyBody, wordCount } from "./agent-evaluation.js";
import { correctionPrompt } from "./correction.js";
import { contracts } from "./integrations/pi-claimcheck.js";
import { bodyEnd } from "./proof-guarantees.js";
import { hostProvider } from "./host-environment.js";
import { openModelTarget, startWorkingAgent } from "./integrations/model-session.js";
import { readModelChoices } from "./model-roles.js";
import { type TokenUsage, totalTokens } from "./token-usage.js";
import { proveSource } from "./verification/lemmascript-verifier.js";

/**
 * Run the working agent's evaluation for issue #165 live and write one JSON
 * record under live-runs/agent/. Each request and question goes to a fresh
 * agent with Tesota's own prompt, in a fresh Git repository, so a prompt
 * change is measured by running this before and after it. The agent may run
 * only Node's test runner; a hidden test, run afterwards, decides a fix, and
 * for a scope case a preserved test and the case's allowed paths and kept code
 * decide whether it did only what was asked; for a premise case, whether it
 * left alone a request whose premise is false and fixed the control; for a
 * proof case (#294), whether its file proves after the turn and its contract
 * was not weakened. `--proofs=guidance` gives the agent the contract
 * guidance, and `--proofs=tool` the `prove` tool with its guidance, so the
 * same cases run in each arm. The strengthen set sends the correction Tesota
 * would build for a bug a proved contract allowed, with `--strengthen=on`
 * adding the request to strengthen the contract, and records whether the
 * contract the turn left rules the bug out.
 *
 *   bun run live:agent [--runs=N] [--set=all|fixes|scope|premise|proofs|strengthen|questions]
 *     [--proofs=off|guidance|tool] [--strengthen=off|on] [--model-agent=<id>]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(option("runs") ?? "2");
if (!Number.isInteger(runs) || runs < 1) throw new Error("Use --runs=N with N at least 1.");
const set = option("set") ?? "all";
if (!["all", "fixes", "scope", "premise", "proofs", "strengthen", "questions"].includes(set)) {
  throw new Error("Use --set=all, fixes, scope, premise, proofs, strengthen or questions.");
}
const strengthen = option("strengthen") ?? "off";
if (strengthen !== "off" && strengthen !== "on") throw new Error("Use --strengthen=off or on.");
const armOption = option("proofs") ?? "off";
if (armOption !== "off" && armOption !== "guidance" && armOption !== "tool") throw new Error("Use --proofs=off, guidance or tool.");
const arm: "off" | "guidance" | "tool" = armOption;
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

interface Turn {
  readonly status: string; readonly reply: string; readonly tokens: number; readonly durationMs: number; readonly commands: string[];
  /** How many times the agent ran `prove`. */
  readonly proofRuns: number;
}

async function ask(directory: string, request: string): Promise<Turn> {
  let tokens = 0;
  let proofRuns = 0;
  const commands: string[] = [];
  const session = await startWorkingAgent({ target, onUsage: (usage: TokenUsage) => { tokens += totalTokens(usage); } },
    { cwd: directory, environment: await hostProvider.prepare(directory), sandboxed: false, ...arm === "off" ? {} : { proofs: arm },
      approveCommand: async ({ command }) => { commands.push(command); return allowedCommand(command) ? "once" : "deny"; },
      onActivity: (activity) => { if (activity.type === "tool_started" && activity.tool.endsWith("prove")) proofRuns += 1; } },
    { conversationId: randomUUID() });
  const started = Date.now();
  try {
    const turn = await session.run(request, AbortSignal.timeout(15 * 60_000));
    return { status: turn.status, reply: turn.status === "completed" ? turn.reply : "", tokens, durationMs: Date.now() - started, commands,
      proofRuns };
  } finally { session.dispose(); }
}

/** Whether a file proves after a turn: LemmaScript with Dafny on it, as Tesota's own verifier runs it. */
async function provesAfter(directory: string, path: string): Promise<string> {
  const file = join(directory, path);
  if (!existsSync(file)) return "missing";
  return (await proveSource(basename(path), readFileSync(file, "utf8"), undefined, AbortSignal.timeout(10 * 60_000))).outcome;
}

const fixes: unknown[] = [];
const answers: { question: string; run: number; words: number; stated: number; facts: number; changed: string[]; turn: Turn }[] = [];
const outcome: Record<string, { attempts: number; resolved: number; untouched: number }> = {};
const scoped: unknown[] = [];
const scope = { attempts: 0, resolved: 0, inScope: 0, controlAttempts: 0, controlInScope: 0, mentionable: 0, mentioned: 0 };
const premised: unknown[] = [];
const premise = { attempts: 0, leftAlone: 0, reported: 0, controlAttempts: 0, controlResolved: 0 };
const proofAttempts: unknown[] = [];
const strengthenAttempts: unknown[] = [];
const strengthened: Record<string, { attempts: number; resolved: number; proved: number; rulesOut: number; keptPromise: number;
  tokens: number; durationMs: number }> = {};
const proofs: Record<string, { attempts: number; proved: number; resolved: number; weakened: number; proofRuns: number;
  tokens: number; durationMs: number }> = {};
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
    for (const testCase of includes("proofs") ? AGENT_PROOF_CASES : []) {
      const directory = repository(testCase.name, testCase.base);
      const turn = await ask(directory, testCase.request);
      const changed = changedPaths(directory);
      const resolved = passes(directory, "check.test.ts", testCase.hiddenTest);
      const path = testCase.path;
      const proof = path === undefined ? "no contract" : await provesAfter(directory, path);
      const proved = path === undefined || proof === "passed";
      const after = path === undefined || !existsSync(join(directory, path)) ? undefined : readFileSync(join(directory, path), "utf8");
      const weakened = path === undefined ? [] : contractWeakened(testCase.base[path] ?? "", after, testCase.kept);
      const tally = proofs[testCase.name] ??= { attempts: 0, proved: 0, resolved: 0, weakened: 0, proofRuns: 0, tokens: 0, durationMs: 0 };
      tally.attempts += 1;
      tally.proved += proved ? 1 : 0;
      tally.resolved += resolved ? 1 : 0;
      tally.weakened += weakened.length > 0 ? 1 : 0;
      tally.proofRuns += turn.proofRuns;
      tally.tokens += turn.tokens;
      tally.durationMs += turn.durationMs;
      proofAttempts.push({ name: testCase.name, kind: testCase.kind, run, resolved, proved, proof, weakened, changed,
        words: wordCount(turn.reply), turn });
      const weakenedNote = weakened.length === 0 ? "" : `, weakened (${weakened.join("; ")})`;
      console.log(`run ${run} · ${testCase.name}: ${resolved ? "resolved" : "not resolved"}, ` +
        `${proved ? "proved" : `not proved (${proof})`}${weakenedNote}, ${turn.proofRuns} prove runs, ` +
        `${Math.round(turn.tokens / 1000)}k tokens, ${Math.round(turn.durationMs / 1000)} s` +
        (turn.status === "completed" ? "" : ` (${turn.status})`));
    }
    for (const testCase of set === "strengthen" ? AGENT_STRENGTHEN_CASES : []) {
      const directory = repository(testCase.name, testCase.base);
      const base = testCase.base[testCase.path] ?? "";
      const contract = contracts(testCase.path, base).find((item) => item.name === testCase.function);
      const proved = contract === undefined || strengthen === "off" ? [] : [{ path: testCase.path,
        lines: Array.from({ length: bodyEnd(base, contract.endLine) - contract.endLine + 1 }, (_value, index) => contract.endLine + index),
        contracts: [contract.text] }];
      const request = correctionPrompt([testCase.request], { failedChecks: [], obligations: [],
        findings: [{ severity: "high", disposition: "fixable", origin: "introduced", path: testCase.path, ...testCase.finding }] }, proved);
      const turn = await ask(directory, request);
      const resolved = passes(directory, "check.test.ts", testCase.hiddenTest);
      const proof = await provesAfter(directory, testCase.path);
      const file = join(directory, testCase.path);
      const after = existsSync(file) ? readFileSync(file, "utf8") : undefined;
      const prove = async (source: string | undefined): Promise<string | undefined> => source === undefined ? undefined
        : (await proveSource(basename(testCase.path), source, undefined, AbortSignal.timeout(10 * 60_000))).outcome;
      // Both judged by the prover, and only on a contract that proves: one that does not parse fails every body.
      const bugProof = after === undefined ? undefined : await prove(withBuggyBody(base, after, testCase.path, testCase.function));
      const rulesOut = proof === "passed" && bugProof === "failed";
      // The new code under the original contract: it keeps the original promise unless the turn loosened it.
      const keptProof = after === undefined ? undefined : await prove(withBuggyBody(after, base, testCase.path, testCase.function));
      const keptPromise = proof === "passed" && keptProof === "passed";
      const tally = strengthened[testCase.name] ??= { attempts: 0, resolved: 0, proved: 0, rulesOut: 0, keptPromise: 0, tokens: 0,
        durationMs: 0 };
      tally.attempts += 1;
      tally.resolved += resolved ? 1 : 0;
      tally.proved += proof === "passed" ? 1 : 0;
      tally.rulesOut += rulesOut ? 1 : 0;
      tally.keptPromise += keptPromise ? 1 : 0;
      tally.tokens += turn.tokens;
      tally.durationMs += turn.durationMs;
      strengthenAttempts.push({ name: testCase.name, run, resolved, proof, bugProof, rulesOut, keptProof, keptPromise, after, turn });
      console.log(`run ${run} · ${testCase.name}: ${resolved ? "resolved" : "not resolved"}, ` +
        `${proof === "passed" ? "proved" : `not proved (${proof})`}, ${rulesOut ? "contract rules the bug out" :
          "contract does not rule the bug out"}, ${keptPromise ? "keeps the original promise" : "does not keep the original promise"}` +
        `, ${turn.proofRuns} prove runs, ` +
        `${Math.round(turn.tokens / 1000)}k tokens, ${Math.round(turn.durationMs / 1000)} s` +
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
const record = { at: new Date().toISOString(), model: agentId, runs, set, arm,
  fixes: outcome, scope, premise, proofs, strengthen: { arm: strengthen, cases: strengthened },
  answers: { replies: words.length, unfinished: answers.length - words.length, medianWords: quantile(words, 0.5),
    p90Words: quantile(words, 0.9), stated: answers.reduce((sum, entry) => sum + entry.stated, 0),
    facts: answers.reduce((sum, entry) => sum + entry.facts, 0),
    changedFiles: answers.filter((entry) => entry.changed.length > 0).length },
  attempts: { fixes, scope: scoped, premise: premised, proofs: proofAttempts, strengthen: strengthenAttempts, answers } };
mkdirSync(join("live-runs", "agent"), { recursive: true });
const file = join("live-runs", "agent", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`fixes ${JSON.stringify(record.fixes)}\nscope ${JSON.stringify(record.scope)}\npremise ${JSON.stringify(record.premise)}\n` +
  `proofs ${JSON.stringify(record.proofs)}\nstrengthen ${JSON.stringify(record.strengthen)}\n` +
  `answers ${JSON.stringify(record.answers)}\nrecorded ${file}`);
