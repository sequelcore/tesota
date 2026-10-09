import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type Contract, changedContracts, contracts } from "../src/proof-guarantees.js";
import { claimCheck } from "../src/pi-claimcheck.js";
import { installedPi } from "../src/pi-install.js";
import { runProcess } from "../src/process.js";
import type { Receipt } from "../src/receipt.js";
import { proveFile, proveSource } from "../src/verification/lemmascript-verifier.js";
import { NO_CONTRACT_CASES, PROOF_CASES, type ProofCase, STRENGTHEN_CASES, type StrengthenCase, contractWeakened, withBuggyBody }
  from "./cases.js";

/**
 * Slice 8's live evaluation (#350): each registered case runs in a fresh Git
 * repository through `pi -p`, with Tesota's package through the built
 * launcher or, in the `plain` arm, without it. The model comes from the
 * operator's Pi sign-in: `OPENAI_API_KEY` is removed and stdin is closed. Each
 * run appends one JSON line to `--out`, which a later call resumes from. The
 * `claimcheck` mode replays ClaimCheck, with the session's model alone and
 * with a second model, on the contracts the runs left and on the strengthen
 * cases' weak and reference contracts, and appends its judgments.
 *
 *   bun run live:eval --out=<file> --arm=tesota|plain --set=proofs|strengthen|no-contracts
 *     [--cases=<name>,<name>] [--runs=3] [--model=openai/gpt-6-luna]
 *   bun run live:eval --out=<file> --claimcheck [--second=openai/gpt-5.5] [--repeats=3] [--model=openai/gpt-6-luna]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const out = option("out");
if (out === undefined) throw new Error("Name the results file with --out=<file>, outside the repository.");
const model = option("model") ?? "openai/gpt-6-luna";
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
delete process.env["OPENAI_API_KEY"];

/** One case as the suite runs it: the strengthen cases' file starts untracked, so its contract counts as added. */
interface LiveCase {
  readonly name: string;
  readonly request: string;
  readonly committed: Readonly<Record<string, string>>;
  readonly untracked: Readonly<Record<string, string>>;
  readonly hiddenTest: string;
  readonly path?: string;
  /** The function whose registered bug the final contract should rule out. */
  readonly function?: string;
  /** The source the bug comes from, and the contract lines that must stay. */
  readonly buggy?: string;
  readonly kept: readonly string[];
}

function fromProofCase(testCase: ProofCase): LiveCase {
  const buggy = testCase.path === undefined ? undefined : testCase.base[testCase.path];
  const name = testCase.path === undefined || buggy === undefined ? undefined : contracts(testCase.path, buggy)[0]?.name;
  return { name: testCase.name, request: testCase.request, committed: testCase.base, untracked: {}, hiddenTest: testCase.hiddenTest,
    ...testCase.path === undefined ? {} : { path: testCase.path }, ...name === undefined ? {} : { function: name },
    ...buggy === undefined ? {} : { buggy }, kept: testCase.kept };
}

function fromStrengthenCase(testCase: StrengthenCase): LiveCase {
  const buggy = testCase.base[testCase.path] ?? "";
  const committed = Object.fromEntries(Object.entries(testCase.base).filter(([path]) => path !== testCase.path));
  return { name: testCase.name, request: testCase.request, committed, untracked: { [testCase.path]: buggy },
    hiddenTest: testCase.hiddenTest, path: testCase.path, function: testCase.function, buggy, kept: [] };
}

const sets: Readonly<Record<string, readonly LiveCase[]>> = {
  proofs: PROOF_CASES.map(fromProofCase),
  strengthen: STRENGTHEN_CASES.map(fromStrengthenCase),
  "no-contracts": NO_CONTRACT_CASES.map(fromProofCase),
};

const manifest = JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2);

function write(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
}

function repository(root: string, testCase: LiveCase): string {
  const directory = join(root, "project");
  write(directory, { ...testCase.committed, "package.json": manifest, ".gitignore": "node_modules\n" });
  const git = (...args: string[]): void => {
    const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: directory, encoding: "utf8" });
    if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  write(directory, testCase.untracked);
  return directory;
}

const read = (path: string): string | undefined => existsSync(path) ? readFileSync(path, "utf8") : undefined;

/** The fields of a Pi session entry the suite reads. */
interface SessionEntry {
  readonly type: string;
  readonly customType?: string;
  readonly content?: unknown;
  readonly details?: unknown;
  readonly thinkingLevel?: string;
  readonly message?: { readonly role: string; readonly content?: readonly { readonly type: string; readonly name?: string }[] | string;
    readonly usage?: Readonly<Record<string, number>> };
}

/** What the session file records: the model's usage and requests, the tools run, what went back, and the last receipt. */
function sessionFacts(sessions: string): Record<string, unknown> {
  const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((path) => path.endsWith(".jsonl")) : [];
  const entries = files.flatMap((path) => (read(join(sessions, path)) ?? "").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SessionEntry));
  const assistant = entries.flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : []);
  const tools = assistant.flatMap((message) => typeof message.content === "string" ? []
    : (message.content ?? []).filter((part) => part.type === "toolCall").map((part) => part.name));
  const gate = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "tesota-gate").map((entry) => String(entry.content));
  const receipts = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "tesota-receipt");
  const sum = (key: string): number => assistant.reduce((total, message) => total + (message.usage?.[key] ?? 0), 0);
  return {
    sessions: files.length, modelRequests: assistant.length, tokens: { input: sum("input"), output: sum("output"),
      cacheRead: sum("cacheRead"), total: sum("totalTokens") },
    thinking: entries.find((entry) => entry.type === "thinking_level_change")?.thinkingLevel,
    tools: tools.length, proveCalls: tools.filter((name) => name === "prove").length,
    sentBack: { proof: gate.filter((text) => text.includes("does not prove yet")).length,
      tests: gate.filter((text) => text.includes("fails with your changes")).length,
      weak: gate.filter((text) => text.startsWith("Tesota: the contract of")).length },
    receipt: receipts.at(-1)?.details as Receipt | undefined,
  };
}

/** Whether the registered bug's body fails the proof under the contract the run left: true when the contract rules it out. */
async function rulesOut(testCase: LiveCase, after: string | undefined): Promise<boolean | null> {
  if (testCase.path === undefined || testCase.function === undefined || testCase.buggy === undefined || after === undefined) return null;
  const source = withBuggyBody(testCase.buggy, after, testCase.path, testCase.function);
  if (source === undefined) return null;
  const outcome = await proveSource(basename(testCase.path), source, AbortSignal.timeout(300_000));
  return outcome === "failed" ? true : outcome === "passed" ? false : null;
}

async function liveRun(arm: string, set: string, testCase: LiveCase, run: number): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), "tesota-eval-"));
  const directory = repository(root, testCase);
  const sessions = join(root, "sessions");
  const pi = installedPi(checkout);
  if (pi === undefined) throw new Error("No Pi is installed in the checkout; run bun install.");
  const launcher = arm === "plain" ? [pi.cli] : [join(checkout, "dist", "cli.js")];
  const args = [...launcher, "-p", "--model", model, "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--no-mcp", "--session-dir", sessions, testCase.request];
  const started = Date.now();
  const ended = await runProcess(process.execPath, args, directory, new AbortController().signal, 30 * 60_000);
  const durationMs = Date.now() - started;
  const after = testCase.path === undefined ? undefined : read(join(directory, testCase.path));
  const proof = testCase.path === undefined ? undefined : await proveFile(directory, testCase.path, AbortSignal.timeout(600_000));
  write(directory, { ".hidden/check.test.ts": testCase.hiddenTest });
  const resolved = spawnSync("node", ["--test", ".hidden/check.test.ts"], { cwd: directory, encoding: "utf8" }).status === 0;
  const facts = sessionFacts(sessions);
  const receipt = facts["receipt"] as Receipt | undefined;
  const baseSource = testCase.path === undefined ? undefined : testCase.committed[testCase.path];
  const judged: Contract[] = testCase.path === undefined || after === undefined ? [] : changedContracts(testCase.path, after, baseSource);
  return {
    arm, set, case: testCase.name, run, model, ended: ended.ended, exitCode: ended.exitCode, durationMs,
    ...ended.ended === "exited" && ended.exitCode === 0 ? {} : { output: ended.output.slice(-2000) },
    ...facts, receipt: undefined,
    receiptSummary: receipt === undefined ? undefined : {
      proofs: receipt.proofs.map(({ path, verdict }) => ({ path, verdict })),
      contracts: receipt.contracts.map(({ path, name, mutation, judgment }) => ({ path, name, survived: mutation.survived.length,
        rejected: mutation.rejected, inconclusive: mutation.inconclusive, equivalent: mutation.equivalent, verdict: judgment?.verdict })),
      claimcheck: receipt.claimcheck,
      tests: receipt.tests.map(({ command, evidence, verdict }) => ({ command, outcome: evidence.outcome, verdict })),
      exercises: receipt.exercises, weakened: receipt.weakened, unverified: receipt.unverified, uncovered: receipt.uncovered,
    },
    proved: proof?.outcome, resolved,
    weakened: testCase.path === undefined || baseSource === undefined && testCase.untracked[testCase.path] === undefined ? []
      : contractWeakened(baseSource ?? testCase.untracked[testCase.path] ?? "", after, testCase.kept),
    rulesOut: await rulesOut(testCase, after),
    changed: spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: directory, encoding: "utf8" }).stdout
      .split("\n").filter((line) => line.length > 3).map((line) => line.slice(3).trim()),
    after, judgedContracts: judged, directory,
  };
}

function records(): Record<string, any>[] {
  return (read(out ?? "") ?? "").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, any>);
}

function append(record: Record<string, unknown>): void {
  mkdirSync(dirname(resolve(out ?? "")), { recursive: true });
  appendFileSync(out ?? "", `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
}

async function live(): Promise<void> {
  const arm = option("arm") ?? "";
  if (!["tesota", "plain"].includes(arm)) throw new Error("Use --arm=tesota or plain.");
  const set = option("set") ?? "";
  const chosen = sets[set];
  if (chosen === undefined) throw new Error("Use --set=proofs, strengthen or no-contracts.");
  const names = option("cases")?.split(",");
  const cases = names === undefined ? chosen : chosen.filter((testCase) => names.includes(testCase.name));
  if (names !== undefined && cases.length !== names.length) throw new Error(`Unknown case among ${names.join(", ")}.`);
  const runs = Number(option("runs") ?? "3");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("Use --runs=N with N at least 1.");
  if (arm !== "plain" && !existsSync(join(checkout, "dist", "cli.js"))) throw new Error("Build the launcher first: bun run build.");
  const done = new Set(records().filter((record) => record["kind"] === undefined).map((record) =>
    `${record["arm"]}|${record["case"]}|${record["run"]}|${record["model"]}`));
  for (let run = 1; run <= runs; run += 1) {
    for (const testCase of cases) {
      if (done.has(`${arm}|${testCase.name}|${run}|${model}`)) continue;
      process.stdout.write(`${arm} ${testCase.name} run ${run}... `);
      const record = await liveRun(arm, set, testCase, run);
      append(record);
      process.stdout.write(`${String(record["ended"])}, proved ${String(record["proved"])}, resolved ${String(record["resolved"])}, ` +
        `${String(record["modelRequests"])} requests\n`);
    }
  }
}

/** The contract judged against the request, with whether it rules the registered bug out without weakening, as its label. */
interface Judged { readonly source: string; readonly request: string; readonly items: readonly Contract[]; readonly expresses: boolean | null }

async function replay(): Promise<void> {
  const second = option("second") ?? "openai/gpt-5.5";
  const repeats = Number(option("repeats") ?? "3");
  const registry = new ModelRegistry(await ModelRuntime.create());
  const slash = model.indexOf("/");
  const session = registry.find(model.slice(0, slash), model.slice(slash + 1));
  if (session === undefined) throw new Error(`${model} is not in Pi's model registry.`);
  const labelled: Judged[] = STRENGTHEN_CASES.flatMap((testCase) => [
    { source: `weak base: ${testCase.name}`, request: testCase.request, expresses: false,
      items: contracts(testCase.path, testCase.base[testCase.path] ?? "") },
    { source: `reference: ${testCase.name}`, request: testCase.request, expresses: true, items: contracts(testCase.path, testCase.reference) }]);
  const fromRuns: Judged[] = records().filter((record) => record["kind"] === undefined && (record["judgedContracts"] ?? []).length > 0)
    .map((record) => ({ source: `run: ${record["arm"]} ${record["case"]} ${record["run"]}`,
      request: [...PROOF_CASES, ...STRENGTHEN_CASES].find((testCase) => testCase.name === record["case"])?.request ?? "",
      items: record["judgedContracts"], expresses: record["rulesOut"] === null ? null
        : record["rulesOut"] === true && (record["weakened"] ?? []).length === 0 }));
  const done = new Set(records().filter((record) => record["kind"] === "claimcheck").map((record) =>
    `${record["source"]}|${record["config"]}|${record["repeat"]}`));
  for (const item of [...labelled.flatMap((entry) => Array.from({ length: repeats }, (_, k) => ({ ...entry, repeat: k + 1 }))),
    ...fromRuns.map((entry) => ({ ...entry, repeat: 1 }))]) {
    for (const [config, restateWith] of [["one model", undefined], ["second model", second]] as const) {
      if (done.has(`${item.source}|${config}|${item.repeat}`)) continue;
      const result = await claimCheck({ model: session, modelRegistry: registry }, [item.request], item.items,
        AbortSignal.timeout(600_000), restateWith);
      append({ kind: "claimcheck", source: item.source, config, repeat: item.repeat, expresses: item.expresses, result });
      process.stdout.write(`${item.source} ${config} ${item.repeat}: ${result.status === "judged"
        ? result.judgments.map(({ verdict }) => verdict).join(", ") : result.reason}\n`);
    }
  }
}

await (process.argv.includes("--claimcheck") ? replay() : live());
