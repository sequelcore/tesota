import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DELEGATION_CASES, DELEGATION_COMMIT, type DelegationScore, scoreAnswer } from "./delegation-evaluation.js";
import { hostProvider } from "./host-environment.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { CodingSession } from "./integrations/pi-coding-session.js";
import { ExplorerPool } from "./integrations/pi-explore.js";
import { askExplorer } from "./integrations/pi-explorer.js";
import { DEFAULT_MODEL, EXPLORERS_OFF, readModelChoices } from "./model-roles.js";

/**
 * Run the delegation evaluation live (decision 019) and write one JSON record
 * under live-runs/delegation/. Each question is asked of a fresh agent without
 * explorers and of a fresh agent with them, on the same frozen checkout.
 * Commands are refused, so the agent can only read.
 *
 *   bun run live:delegation [--runs=N] [--model-agent=<id>] [--model-explorer=<id>]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(option("runs") ?? "2");
if (!Number.isInteger(runs) || runs < 1) throw new Error("Use --runs=N with N at least 1.");
const chosen = readModelChoices();
const agentId = option("model-agent") ?? chosen.agent;
const explorerId = option("model-explorer") ?? (chosen.explorer === EXPLORERS_OFF ? DEFAULT_MODEL : chosen.explorer);

const runtime = await ModelRuntime.create({ credentials: new CodexCredentials(), refreshOnCreate: false, allowModelNetwork: false });
const model = (id: string): Model<Api> => {
  const found = runtime.getModel("openai-codex", id);
  if (found === undefined) throw new Error(`${id} is unavailable. Check tesota models and tesota auth status.`);
  return found;
};
const agentModel = model(agentId);
const explorerModel = model(explorerId);

const root = mkdtempSync(join(tmpdir(), "tesota-delegation-eval-"));
const checkout = join(root, "repo");
const git = (args: string[], cwd?: string): void => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
};

interface Attempt {
  readonly name: string;
  readonly mode: "single" | "explorers";
  readonly run: number;
  readonly score: DelegationScore;
  readonly tokens: number;
  readonly durationMs: number;
  readonly explorerCalls: number;
  readonly status: string;
  readonly answer: string;
}

async function attempt(question: string, explorers: boolean): Promise<Omit<Attempt, "name" | "mode" | "run" | "score">> {
  let tokens = 0;
  let explorerCalls = 0;
  const count = (value: number): void => { tokens += value; };
  const pool = explorers ? new ExplorerPool(async (brief, signal, _onLine, onUsage) => {
    explorerCalls += 1;
    return askExplorer({ modelRuntime: runtime, model: explorerModel, onUsage: (value) => { onUsage(value); count(value); } },
      checkout, brief, signal);
  }) : undefined;
  const session = await CodingSession.create({ cwd: checkout, modelRuntime: runtime, model: agentModel,
    environment: await hostProvider.prepare(checkout), autonomous: false, approveCommand: async () => "deny",
    onUsage: count, ...(pool === undefined ? {} : { explorers: pool }) });
  const started = Date.now();
  try {
    const turn = await session.run(`${question}\n\nAnswer from the repository. Do not change any files.`,
      AbortSignal.timeout(15 * 60_000));
    return { tokens, durationMs: Date.now() - started, explorerCalls, status: turn.status,
      answer: turn.status === "completed" ? turn.reply : "" };
  } finally { session.dispose(); }
}

const attempts: Attempt[] = [];
try {
  git(["clone", "--quiet", "--no-hardlinks", process.cwd(), checkout]);
  git(["checkout", "--quiet", DELEGATION_COMMIT], checkout);
  for (let run = 1; run <= runs; run += 1) {
    for (const testCase of DELEGATION_CASES) {
      for (const mode of ["single", "explorers"] as const) {
        const result = await attempt(testCase.question, mode === "explorers");
        const score = scoreAnswer(testCase, result.answer);
        attempts.push({ name: testCase.name, mode, run, score, ...result });
        console.log(`run ${run} · ${testCase.name} · ${mode}: ${score.stated}/${score.facts} facts, ` +
          `${Math.round(result.tokens / 1000)}k tokens, ${Math.round(result.durationMs / 1000)} s` +
          (mode === "explorers" ? `, ${result.explorerCalls} explorers` : "") + (result.status === "completed" ? "" : ` (${result.status})`));
      }
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }

const totals = (mode: Attempt["mode"]): Record<string, number> => {
  const of = attempts.filter((entry) => entry.mode === mode);
  const sum = (pick: (entry: Attempt) => number): number => of.reduce((total, entry) => total + pick(entry), 0);
  return { stated: sum((entry) => entry.score.stated), facts: sum((entry) => entry.score.facts), tokens: sum((entry) => entry.tokens),
    durationMs: sum((entry) => entry.durationMs), explorerCalls: sum((entry) => entry.explorerCalls),
    unfinished: of.filter((entry) => entry.status !== "completed").length };
};
const record = { at: new Date().toISOString(), commit: DELEGATION_COMMIT, models: { agent: agentId, explorer: explorerId }, runs,
  single: totals("single"), explorers: totals("explorers"), attempts };
mkdirSync(join("live-runs", "delegation"), { recursive: true });
const file = join("live-runs", "delegation", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`single ${JSON.stringify(record.single)}\nexplorers ${JSON.stringify(record.explorers)}\nrecorded ${file}`);
