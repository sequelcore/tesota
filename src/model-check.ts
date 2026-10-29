import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type Evidence, contentHash } from "./evidence.js";
import { git } from "./git.js";
import { captureGraph, graphContentHash, graphLimits, type GraphCapture, type GraphOptions } from "./model-graph.js";
import { stateVariables } from "./model-state.js";
import { tesotaHome } from "./home.js";
import { noOperations, type OperationResult, type OperationSink, type OperationSpec } from "./operations.js";
import { runProcess } from "./process.js";
import { counterexampleSteps } from "./receipt.js";
import { pathBlobs } from "./request-fingerprint.js";
import { type Environment, runShell } from "./test-rung.js";
import { projectFiles } from "./verification/lemmascript-verifier.js";
import type { ProofOutcome } from "./verification/proof-outcome-rule.js";
import { type FaultVerdict, type ModelRun, type Staleness, faultVerdict, modelOutcome, reportedTlcRun, staleness, tlcRun,
  writtenWithCode } from "./verification/model-rule.js";

/** The word that makes a TLA+ or Quint file a model the gate checks, on the first line of its header. */
export const MODEL_MARKER = "tesota-model";

/** TLC's time limit per run, the proof timeout; a model with F faults takes at most (F + 1) times it. */
const timeoutMs = 5 * 60_000;
/** The heap each TLC run may take, as accepted on 2026-10-21. */
const maxHeap = "-Xmx2g";

/** Where Tesota finds TLC: `tla2tools.jar` in its tools folder (docs/reference/installation.md). */
export function tlaToolsJar(): string {
  return join(tesotaHome(), "tools", "tla2tools.jar");
}

/** A file a model covers, relative to the project root, and the functions in it the model describes. */
export interface ModelCover {
  readonly path: string;
  readonly names: readonly string[];
}

/** A planted fault: a variant of the model that must break one of its invariants, and what it plants in words. */
export interface ModelFault {
  readonly path: string;
  readonly description: string;
}

/**
 * What a model declares about itself in its header: the files and functions
 * it covers, the commit it was last confirmed against, its invariants, the
 * steps it treats as atomic and what it leaves out, its planted faults, and
 * the command that replays its traces against the code, if any.
 */
export interface ModelHeader {
  readonly covers: readonly ModelCover[];
  readonly confirmed?: string;
  readonly invariants: readonly string[];
  readonly atomic: readonly string[];
  readonly omits: readonly string[];
  readonly faults: readonly ModelFault[];
  readonly replay?: string;
}

const headerKeys = new Set(["covers", "confirmed", "invariant", "atomic", "omits", "fault", "replay"]);

/** A header line without the comment marks around it, as TLA+ and Quint write block and line comments. */
function uncommented(line: string): string {
  return line.replace(/\*\)|\*\//gu, "").trim().replace(/^(?:\(\*|\/\*|\\\*|\/\/|\*)\s*/u, "").trim();
}

/**
 * The header of a model, read the same in TLA+ and Quint: from the comment
 * line holding `tesota-model`, each following line `key: value`, until the
 * comment closes or a line is neither a key nor blank. `covers`, `invariant`,
 * `atomic`, `omits` and `fault` may repeat. Undefined when the file has no
 * marker, so it is no model of Tesota's.
 */
export function modelHeader(source: string): ModelHeader | undefined {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(MODEL_MARKER));
  if (start === -1) return undefined;
  const found = { covers: [] as ModelCover[], invariants: [] as string[], atomic: [] as string[], omits: [] as string[],
    faults: [] as ModelFault[], confirmed: undefined as string | undefined, replay: undefined as string | undefined };
  for (const line of lines.slice(start + 1)) {
    const text = uncommented(line);
    const entry = /^([a-z]+):\s*(.+)$/u.exec(text);
    if (entry !== null && headerKeys.has(entry[1] ?? "")) {
      const [, key, value = ""] = entry;
      const [first = "", ...rest] = value.trim().split(/\s+/u);
      if (key === "covers") found.covers.push({ path: first, names: rest });
      else if (key === "fault") found.faults.push({ path: first, description: rest.join(" ") });
      else if (key === "invariant") found.invariants.push(...value.split(",").map((name) => name.trim()).filter((name) => name !== ""));
      else if (key === "atomic") found.atomic.push(value.trim());
      else if (key === "omits") found.omits.push(value.trim());
      else if (key === "confirmed") found.confirmed = first;
      else found.replay = value.trim();
    } else if (text !== "") break;
    if (/\*\)|\*\//u.test(line)) break;
  }
  const { confirmed, replay, ...rest } = found;
  return { ...rest, ...confirmed === undefined ? {} : { confirmed }, ...replay === undefined ? {} : { replay } };
}

/** Whether a header's path stays in the project: relative, and never above its root once normalized. */
export function inProject(path: string): boolean {
  const normal = posix.normalize(path.replaceAll("\\", "/"));
  return !posix.isAbsolute(normal) && !/^[A-Za-z]:/u.test(normal) && normal !== ".." && !normal.startsWith("../");
}

/**
 * What a header must declare before its model's result means anything, a
 * path that leaves the project, which is neither read nor run, and a fault
 * that is the model itself; each, in words.
 */
export function headerProblems(path: string, header: ModelHeader, source: string, language: ModelLanguage): string[] {
  const itself = new Set([path, configOf(path)]);
  const outside = [...header.covers, ...header.faults].map((entry) => entry.path).filter((file) => !inProject(file));
  return [
    ...outside.map((file) => `${file} is outside the project: covered files and faults are paths from the project root, inside it`),
    ...header.covers.length === 0 ? ["the header names no covered file (`covers: <path> [functions]`)"] : [],
    ...header.invariants.length === 0 ? ["the header names no invariant (`invariant: <name>`)"] : [],
    ...header.invariants.filter((name) => !/^[A-Za-z_]\w*$/u.test(name)).map((name) => `\`${name}\` is not the name of a definition: ` +
      "`invariant:` takes the names of the model's invariant definitions, separated by commas, such as `invariant: NeverOversold`"),
    ...header.atomic.length === 0 ? ["the header does not say which steps the model treats as atomic (`atomic: ...`)"] : [],
    ...header.omits.length === 0 ? ["the header does not say what the model leaves out (`omits: ...`)"] : [],
    ...header.faults.filter((fault) => itself.has(fault.path)).map((fault) => `the fault ${fault.path} is the model itself: a fault is a ` +
      "variant that plants a bug, such as another .cfg with the lock removed, while the model and its own .cfg describe the code"),
    ...language === "quint" && source.charCodeAt(0) === 0xfeff ? ["the file starts with a byte-order mark, which Quint rejects"] : [],
  ];
}

export type ModelLanguage = "tla" | "quint";

function language(path: string): ModelLanguage {
  return path.endsWith(".qnt") ? "quint" : "tla";
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

/** The models of the project at `root`: its `.tla` and `.qnt` files with a header (`modelHeader`), relative to it, in name order. */
export async function findModels(root: string): Promise<string[]> {
  const candidates = [...projectFiles(root)].filter((path) => path.endsWith(".tla") || path.endsWith(".qnt"));
  const models: string[] = [];
  for (const path of candidates.sort()) {
    const source = await readIfPresent(join(root, path));
    if (source !== undefined && modelHeader(source) !== undefined) models.push(path);
  }
  return models;
}

/** The command a run of `file` for the model at `model` launches (`check`), as the operations name it. */
function checkTarget(model: string, file: string): string {
  if (language(model) === "quint") return `quint verify --backend=tlc ${file}`;
  const [spec, config] = file.endsWith(".cfg") ? [model, file] : [file, configOf(file)];
  return `java tlc2.TLC -config ${config} ${spec}`;
}

/** How a model run ended, as an operation's result: a violation is a failed run. */
function modelRunResult(run: ModelRun): OperationResult {
  return run === "violated" || run === "malformed" ? "failed" : run;
}

/** A TLA+ specification's configuration, which TLC reads beside it by default. */
function configOf(spec: string): string {
  return spec.replace(/\.tla$/u, ".cfg");
}

/**
 * The files a model's check depends on besides the code it covers: the
 * model, a TLA+ model's configuration, and each fault with a TLA+ fault's
 * configuration.
 */
export function modelOwnFiles(path: string, header: ModelHeader): string[] {
  const withConfig = (file: string): string[] => file.endsWith(".tla") ? [file, configOf(file)] : [file];
  return [...new Set([...withConfig(path), ...header.faults.flatMap((fault) => withConfig(fault.path))])];
}

/** A model of the project, its header, whether the request changed it or what it covers, and the hash of what its check reads. */
export interface ModelPlan {
  readonly path: string;
  readonly header: ModelHeader;
  readonly touched: boolean;
  readonly contentHash: string;
}

/**
 * The models of the project at `root` as the request (`changed`) leaves
 * them (`ModelPlan`), and the TLA+ or Quint files it changed that no header
 * declares: each `.qnt`, and each `.tla` with a configuration beside it,
 * that is neither a model nor one's fault, so the gate can ask for a header.
 * A `.tla` without a configuration is a module others extend.
 */
export async function plannedModels(root: string, changed: readonly string[]): Promise<{ models: ModelPlan[]; unheaded: string[] }> {
  const headed = await Promise.all((await findModels(root)).map(async (path): Promise<ModelPlan> => {
    const header = modelHeader(await readIfPresent(join(root, path)) ?? "") ?? { covers: [], invariants: [], atomic: [], omits: [], faults: [] };
    const reads = [...modelOwnFiles(path, header), ...header.covers.map((cover) => cover.path)];
    return { path, header, touched: reads.some((file) => changed.includes(file)), contentHash: contentHash(await modelContent(root, path, header)) };
  }));
  // A fault copied from its model keeps the header, but is checked as the model's fault, never as a model of its own.
  const faults = new Set(headed.flatMap(({ header }) => header.faults.map((fault) => fault.path)));
  const models = headed.filter(({ path }) => !faults.has(path));
  const declared = new Set(models.flatMap(({ path, header }) => modelOwnFiles(path, header)));
  const unheaded: string[] = [];
  for (const path of changed) {
    if (declared.has(path) || !(path.endsWith(".qnt") || path.endsWith(".tla"))) continue;
    if (await readIfPresent(join(root, path)) === undefined) continue;
    if (path.endsWith(".qnt") || await readIfPresent(join(root, configOf(path))) !== undefined) unheaded.push(path);
  }
  return { models, unheaded };
}

/** One step of a counterexample: the action the model took, and the variables it changed, all of them for the first. */
export interface CounterexampleStep {
  readonly action: string;
  readonly changes: readonly string[];
}

/** A counterexample as TLC prints it: which property broke, and the steps that reach it. */
export interface Counterexample {
  readonly violation: string;
  readonly steps: readonly CounterexampleStep[];
}

/**
 * The counterexample in TLC's output, Quint's included, which runs TLC:
 * the first error it reports, then each `State n: <Action ...>` with the
 * variables that changed from the state before. The action keeps the
 * model's names, which a model true to its code takes from the code.
 * Undefined when the output holds no trace.
 */
export function tlcCounterexample(output: string): Counterexample | undefined {
  const lines = output.split(/\r?\n/u);
  const traceAt = lines.findIndex((line) => line.startsWith("Error: The behavior up to this point is:"));
  if (traceAt === -1) return undefined;
  const violation = lines.slice(0, traceAt).find((line) => line.startsWith("Error: "))?.slice("Error: ".length).trim() ?? "a property breaks";
  const steps: CounterexampleStep[] = [];
  let previous = new Map<string, string>();
  for (let k = traceAt + 1; k < lines.length; k += 1) {
    const header = /^State (\d+): (.*)$/u.exec(lines[k] ?? "");
    if (header === null) {
      if (/^\d[\d,]* states generated|^Error: |^Finished /u.test(lines[k] ?? "")) break;
      continue;
    }
    const block: string[] = [];
    for (k += 1; k < lines.length && (lines[k] ?? "").trim() !== "" && !/^State \d+: /u.test(lines[k] ?? ""); k += 1) block.push(lines[k] ?? "");
    k -= 1;
    const label = header[2] ?? "";
    const action = label.startsWith("<Initial predicate>") ? "initial state"
      : /^<([^ >]+(?:\([^)]*\))?)/u.exec(label)?.[1] ?? label.replace(/^<|>$/gu, "");
    const variables = stateVariables(block);
    const changes = [...variables].filter(([name, value]) => previous.get(name) !== value).map(([name, value]) => `${name} = ${value}`);
    steps.push({ action, changes });
    previous = variables;
  }
  return { violation, steps };
}

/** How one checker run ended, the end of what it printed, and the start of its standard output, which holds a counterexample. */
interface CheckerRun {
  readonly run: ModelRun;
  readonly output: string;
  readonly trace: string;
  readonly durationMs: number;
  readonly capture?: GraphCapture;
}

function captureOf(run: CheckerRun): GraphCapture {
  return run.capture ?? { status: "unavailable", reason: "Graph capture requires a session file and a TLC run; Quint graph extraction is unavailable" };
}

function distinctStates(output: string): number {
  const counted = [...output.matchAll(/([\d,]+) distinct states? found/gu)].at(-1)?.[1];
  return counted === undefined ? 0 : Number(counted.replaceAll(",", ""));
}

/**
 * TLC on a TLA+ specification of the project at `root`: its configuration,
 * with the header's invariants added so they are what TLC checks, written to
 * a temporary folder that also holds TLC's state and the standard modules it
 * extracts, removed after. A missing Java or TLC is a run that did not start.
 */
async function runTlc(root: string, spec: string, config: string, invariants: readonly string[], jar: string,
  signal: AbortSignal, capture?: GraphOptions, evidenceHash = ""): Promise<CheckerRun> {
  const started = Date.now();
  if (await readIfPresent(jar) === undefined) {
    return { run: "not_started", durationMs: 0, trace: "", output: `TLC is not installed: Tesota looks for tla2tools.jar at ${jar}.` };
  }
  const directory = await mkdtemp(join(tmpdir(), "tesota-tlc-"));
  try {
    const written = join(directory, posix.basename(config));
    const configSource = await readIfPresent(join(root, config)) ?? "";
    const modelSource = await readIfPresent(join(root, spec)) ?? "";
    const effectiveConfig = `${configSource}\n${invariants.map((name) => `INVARIANT ${name}`).join("\n")}\n`;
    await writeFile(written, effectiveConfig);
    const dotFile = join(directory, "reached.dot");
    let capturedOutput = "";
    let outputBytes = 0;
    const decoder = new StringDecoder("utf8");
    let reportTail = "";
    let violated = false;
    // From the specification's folder, where TLC finds the modules it extends.
    const args = [maxHeap, "-XX:+UseParallelGC", `-Djava.io.tmpdir=${directory}`, "-cp", jar, "tlc2.TLC",
      "-workers", "auto", "-metadir", join(directory, "states"), "-dump", "dot,actionlabels", dotFile,
      ...capture?.continue === true ? ["-continue"] : [], "-config", written, posix.basename(spec)];
    const ran = await runProcess("java", args, join(root, posix.dirname(spec)),
    signal, timeoutMs, undefined, { onStdout: (chunk) => {
      const decoded = decoder.write(chunk);
      reportTail += decoded;
      violated ||= /Error: (?:Invariant \w+ is violated|Action property .* is violated|Deadlock reached|Temporal properties were violated|The first argument of Assert)/u.test(reportTail);
      reportTail = reportTail.slice(-1024);
      outputBytes += chunk.length;
      if (outputBytes <= (capture?.limits?.bytes ?? graphLimits.bytes)) capturedOutput += decoded;
    } });
    const output = ran.ended === "not_started" ? `Java could not start, so TLC did not run: ${ran.output}` : ran.output;
    return { run: reportedTlcRun(tlcRun(ran.ended === "cancelled", ran.ended === "timed_out", ran.ended !== "not_started", ran.exitCode ?? -1,
      distinctStates(output)), violated), output, trace: ran.stdout, durationMs: Date.now() - started,
      ...capture === undefined ? {} : { capture: await captureGraph(dotFile, capturedOutput, { sessionFile: capture.sessionFile, root, model: spec, config,
          command: ["java", ...args], startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
          processEnded: ran.ended, evidenceOutputHash: graphContentHash(output), modelHash: graphContentHash(modelSource), configHash: graphContentHash(configSource),
          effectiveConfigHash: graphContentHash(effectiveConfig), evidenceHash, exitCode: ran.exitCode }, capture, outputBytes <= (capture.limits?.bytes ?? graphLimits.bytes)) } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/**
 * Quint on a model of the project at `root`: `quint typecheck`, whose
 * errors the model's author must fix, then `quint verify --backend=tlc` with
 * the header's invariants and a 2 GB heap for TLC. A verify that neither
 * found a violation nor passed did not run, as when Quint cannot start
 * Apalache, which it needs to translate the model for TLC; on Windows under
 * Node 24 it cannot (`spawn EINVAL`).
 */
async function runQuint(root: string, model: string, invariants: readonly string[], signal: AbortSignal): Promise<CheckerRun> {
  const started = Date.now();
  const elapsed = (): number => Date.now() - started;
  const typecheck = await runProcess("quint", ["typecheck", model], root, signal, timeoutMs);
  if (typecheck.ended !== "exited") {
    const output = typecheck.ended === "not_started" ? `Quint could not start, so the model was not checked: ${typecheck.output}` : typecheck.output;
    return { run: tlcRun(typecheck.ended === "cancelled", typecheck.ended === "timed_out", false, -1, 0), output, trace: "", durationMs: elapsed() };
  }
  if (typecheck.exitCode !== 0) return { run: "malformed", output: typecheck.output, trace: "", durationMs: elapsed() };
  const directory = await mkdtemp(join(tmpdir(), "tesota-quint-"));
  try {
    const config = join(directory, "tlc.json");
    await writeFile(config, JSON.stringify({ maxHeap: maxHeap.replace("g", "G") }));
    const ran = await runProcess("quint", ["verify", "--backend=tlc", "--verbosity=3", `--tlc-config=${config}`,
      `--invariant=${invariants.join(",")}`, model], root, signal, timeoutMs);
    const run: ModelRun = ran.ended !== "exited" ? tlcRun(ran.ended === "cancelled", ran.ended === "timed_out", false, -1, 0)
      : ran.output.includes("[violation]") ? "violated" : ran.exitCode === 0 ? tlcRun(false, false, true, 0, distinctStates(ran.output))
        : "not_started";
    const why = /spawn E|Apalache/u.test(ran.output) ? "Quint could not start Apalache, which it needs to translate the model for TLC"
      : "Quint could not check the model with TLC";
    return { run, output: run === "not_started" ? `${why}, so the model was not checked.\n${ran.output.trim()}` : ran.output,
      trace: ran.stdout, durationMs: elapsed() };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

/** One checker run of a model or a fault, in the model's language: a TLA+ fault may be another configuration of the same specification. */
function check(root: string, model: string, file: string, invariants: readonly string[], jar: string, signal: AbortSignal,
  capture?: GraphOptions, evidenceHash?: string): Promise<CheckerRun> {
  if (language(model) === "quint") return runQuint(root, file, invariants, signal);
  return file.endsWith(".cfg") ? runTlc(root, model, file, invariants, jar, signal, capture, evidenceHash)
    : runTlc(root, file, configOf(file), invariants, jar, signal, capture, evidenceHash);
}

/** A planted fault's check: how it ended, what that shows, and what the checker printed. */
export interface FaultCheck extends ModelFault {
  readonly capture?: GraphCapture;
  readonly verdict: FaultVerdict;
  readonly output: string;
  readonly durationMs: number;
}

/** Whether a model's traces replay against the code: the header names no replay, the replay passed, or it did not. */
export type ModelLink = "no_replay" | "linked" | "replay_failed";

/**
 * A model's check, as the receipt keeps it: what the model declares, its
 * evidence, with the outcome the gate judges (`modelOutcome`), how TLC
 * ended, each planted fault, the counterexample when it broke, whether its
 * covered code may have moved on since it was confirmed and which files did,
 * whether the request wrote it with the code, and whether a replay links it.
 */
export interface ModelCheck {
  readonly capture?: GraphCapture;
  readonly path: string;
  readonly language: ModelLanguage;
  readonly header: ModelHeader;
  /** What the header misses (`headerProblems`); the model goes back until none. */
  readonly problems: readonly string[];
  readonly evidence: Evidence;
  readonly run: ModelRun;
  /** The distinct states TLC reported for the model; 0 when it reported none. */
  readonly states: number;
  readonly faults: readonly FaultCheck[];
  readonly counterexample?: Counterexample;
  readonly staleness: Staleness;
  /** The covered files that differ from the confirmed commit. */
  readonly stale: readonly string[];
  readonly writtenWithCode: boolean;
  readonly link: ModelLink;
}

const limits = "Checks the model, not the code: it holds for what the model treats as atomic and leaves in, and only for " +
  "the invariants it names. Unless a trace replay passes, nothing links the model to the code.";

/** The covered files that differ from `confirmed`, or undefined when the commit is not in the repository at `root`. */
async function changedSince(root: string, confirmed: string | undefined, covered: readonly string[]): Promise<string[] | undefined> {
  if (confirmed === undefined || (await git(root, ["rev-parse", "--verify", "--quiet", `${confirmed}^{commit}`]))?.trim() === undefined) {
    return undefined;
  }
  const now = await pathBlobs(root, covered, (await git(root, ["rev-parse", "--show-prefix"]))?.trim() ?? "");
  const changed: string[] = [];
  for (const path of covered) {
    const then = (await git(root, ["rev-parse", "--verify", "--quiet", `${confirmed}:./${path}`]))?.trim() ?? null;
    if (now?.get(path) !== then) changed.push(path);
  }
  return changed;
}

/** The files of a model's check, own and covered, with their content now, in the order `contentHash` covers them. */
export async function modelContent(root: string, path: string, header: ModelHeader): Promise<{ path: string; content: string | undefined }[]> {
  const files = [...new Set([...modelOwnFiles(path, header), ...header.covers.map((cover) => cover.path)])];
  // A path outside the project is never read: it is a header problem (`headerProblems`).
  return Promise.all(files.map(async (file) => ({ path: file, content: inProject(file) ? await readIfPresent(join(root, file)) : undefined })));
}

/**
 * Check the model at `path` of the project at `root`, which the request
 * changed together with `changed`: TLC on the model and, once it passes, on
 * each planted fault, each run within the proof timeout and a 2 GB heap;
 * then the replay its header names, if any. A header that misses a part
 * fails without running anything. The evidence binds the model, its
 * faults and its covered files as they were before the check.
 */
export async function checkModel(root: string, path: string, changed: readonly string[], signal: AbortSignal,
  jar: string = tlaToolsJar(), ops: OperationSink = noOperations, env?: Environment, capture?: GraphOptions): Promise<ModelCheck> {
  const started = Date.now();
  const source = await readIfPresent(join(root, path)) ?? "";
  const header = modelHeader(source) ?? { covers: [], invariants: [], atomic: [], omits: [], faults: [] };
  const content = await modelContent(root, path, header);
  const covered = header.covers.map((cover) => cover.path);
  const since = await changedSince(root, header.confirmed, covered.filter(inProject));
  const own = modelOwnFiles(path, header);
  const withCode = writtenWithCode(own.some((file) => changed.includes(file)), covered.some((file) => changed.includes(file)));
  const facts = { path, language: language(path), header, stale: since ?? [], writtenWithCode: withCode };
  // Judged once the check ends: a model written with its code that passed is measured against the code as the request leaves it.
  const stalenessOf = (outcome: ProofOutcome): Staleness =>
    staleness(withCode, outcome, since !== undefined, covered.map((file) => since?.includes(file) ?? true));
  const claim = `TLC checks that ${header.invariants.join(", ") || "the model's invariants"} hold in every reachable state of ${path}` +
    `${header.faults.length === 0 ? "" : `, and that each of its ${header.faults.length} planted faults breaks one`}.`;
  const evidence = (main: CheckerRun, faults: readonly FaultCheck[]): Evidence => ({ verifier: "tlc", claim, limits,
    outcome: modelOutcome(main.run, faults.map(({ verdict }) => verdict)), output: main.output, durationMs: Date.now() - started,
    files: content.map((file) => file.path), contentHash: contentHash(content) });
  const problems = headerProblems(path, header, source, facts.language);
  if (problems.length > 0) {
    const main: CheckerRun = { run: "malformed", output: problems.join("\n"), trace: "", durationMs: 0 };
    const failed = evidence(main, []);
    return { ...facts, staleness: stalenessOf(failed.outcome), problems, evidence: failed, run: main.run, states: 0, faults: [], link: "no_replay" };
  }
  // Each run is announced before the first starts, so a stop leaves the later ones as not started; the faults and the replay follow the main run.
  const mainSpec: OperationSpec = { method: "model_main", unit: "", target: checkTarget(path, path) };
  const mainId = ops.plan(mainSpec);
  const faultSpecs = header.faults.map((fault): OperationSpec => ({ method: "model_fault", unit: "", target: checkTarget(path, fault.path), parent: mainId }));
  const faultIds = faultSpecs.map((spec) => ops.plan(spec));
  const replaySpec: OperationSpec | undefined = header.replay === undefined ? undefined
    : { method: "model_replay", unit: "", target: header.replay, parent: mainId };
  const replayId = replaySpec === undefined ? undefined : ops.plan(replaySpec);
  const main = await ops.run(mainSpec, () => check(root, path, path, header.invariants, jar, signal, capture, contentHash(content)), ({ run }) => modelRunResult(run), mainId);
  const faults: FaultCheck[] = [];
  if (main.run === "passed") {
    for (const [k, fault] of header.faults.entries()) {
      const ran = await ops.run(faultSpecs[k] ?? mainSpec, () => check(root, path, fault.path, header.invariants, jar, signal, capture, contentHash(content)),
        ({ run }) => modelRunResult(run), faultIds[k]);
      faults.push({ ...fault, verdict: faultVerdict(ran.run), output: ran.output, durationMs: ran.durationMs,
        capture: captureOf(ran) });
    }
  }
  const counterexample = main.run === "violated" ? tlcCounterexample(main.trace) : undefined;
  const result = evidence(main, faults);
  const link: ModelLink = header.replay === undefined || result.outcome !== "passed" ? "no_replay"
    : (await ops.run(replaySpec ?? mainSpec, () => runShell(header.replay ?? "", root, signal, timeoutMs, env), ({ outcome }) => outcome, replayId))
      .outcome === "passed" ? "linked" : "replay_failed";
  return { ...facts, capture: captureOf(main), staleness: stalenessOf(result.outcome), problems, evidence: result, run: main.run, states: distinctStates(main.output), faults, ...counterexample === undefined ? {} : { counterexample }, link };
}

/** The header format, as the gate tells an agent that wrote a model without one. */
export const HEADER_FORMAT: string = [
  "(* tesota-model",
  "   covers: <file the model describes, from the project root> <functions in it>",
  "   confirmed: <the commit the model was last confirmed against>",
  "   invariant: <the name of a definition in the model that TLC checks as an invariant>",
  "   atomic: <the steps the model treats as one indivisible step>",
  "   omits: <the resources and behaviors the model leaves out>",
  "   fault: <an existing variant that must break an invariant: a .tla with its .cfg, another .cfg of this model, or a .qnt> <what it plants>",
  "   replay: <a command that replays the model's traces against the code; leave this line out when there is none>",
  "*)",
].join("\n");

/** What a model's failure must change before it goes back again: its counterexample, its faults' verdicts, or what TLC printed. */
export function modelFailure(check: ModelCheck): string {
  if (check.counterexample !== undefined) return `${check.counterexample.violation}\n${counterexampleSteps(check.counterexample).join("\n")}`;
  if (check.run === "passed") return check.faults.map(({ path, verdict }) => `${path}: ${verdict}`).join("\n") || "no planted fault";
  return `${check.run}\n${check.problems.length > 0 ? check.problems.join("\n") : check.evidence.output}`;
}

/** The end of what a checker printed, for the agent: its errors, not its progress. */
function tail(output: string): string {
  const progress = /^(?:TLC2 Version|Running |Parsing file|Semantic processing|Linting of module|Starting\.\.\.|Computing initial|Finished computing|Finished in|Warning: Please run|\(Use the -nowarning)/u;
  return output.trimEnd().split(/\r?\n/u).filter((line) => !progress.test(line)).join("\n").replace(/\n{3,}/gu, "\n\n").trim()
    .split("\n").slice(-30).join("\n");
}

/**
 * What goes back to the agent for a model that does not pass: the
 * counterexample as numbered steps, with how to tell a bug in the code from
 * one in the model; what TLC could not read; that nothing shows the model
 * can fail; or the planted faults the model cannot tell from the code.
 */
export function modelReport(check: ModelCheck): string {
  const { path, counterexample } = check;
  if (counterexample !== undefined) {
    return `Tesota: TLC finds a counterexample in the model ${path}: ${counterexample.violation}\n\n` +
      `${counterexampleSteps(counterexample).join("\n")}\n\n` +
      "Replay it against the code, step by step. If every step can happen in the code, the code breaks the property: fix the code. " +
      "If a step cannot, the model is wrong: change it to describe the code, and say what was wrong. " +
      "Never weaken an invariant or the model to make it pass.";
  }
  if (check.run === "malformed") {
    return check.problems.length > 0
      ? `Tesota: the header of the model ${path} is not complete:\n\n${check.problems.join("\n")}\n\nIts header reads:\n\n${HEADER_FORMAT}`
      : `Tesota: TLC could not check the model ${path}:\n\n${tail(check.evidence.output)}\n\nFix the model.`;
  }
  if (check.run === "vacuous") return `Tesota: TLC found no reachable state in the model ${path}, so it checked nothing. Fix its initial states.`;
  const weak = check.faults.filter(({ verdict }) => verdict === "passes");
  const broken = check.faults.filter(({ verdict }) => verdict === "broken");
  if (check.faults.length === 0) {
    return `Tesota: the model ${path} passes, but nothing shows it can fail. Declare a planted fault in its header ` +
      "(`fault: <variant> <what it plants>`): a variant that breaks one of its invariants, such as a removed lock or a reordered step, " +
      "kept beside the model so every check runs it.";
  }
  return [`Tesota: the model ${path} passes, but`,
    ...weak.length === 0 ? [] : [`these planted faults pass too, so the model cannot tell them from the code:\n${
      weak.map((fault) => `  ${fault.path}: ${fault.description}`).join("\n")}\n\nStrengthen the model or its invariants, ` +
      "keeping it true to the code, until each fault breaks an invariant."],
    ...broken.length === 0 ? [] : [`TLC could not check these planted faults, so they show nothing:\n${
      broken.map((fault) => `  ${fault.path}: ${tail(fault.output).split("\n").at(-1) ?? ""}`).join("\n")}\n\nFix them.`]].join(" ");
}

/** What goes back for TLA+ or Quint files the request changed that declare no header (`plannedModels`). */
export function unheadedReport(paths: readonly string[]): string {
  return `Tesota: ${paths.join(", ")} ${paths.length === 1 ? "looks like a model" : "look like models"} with no tesota-model header, ` +
    "so Tesota does not check them. If one is a model of the code, start it with a header like this, " +
    `in a comment, so every request that changes it or its code runs TLC on it and its planted faults:\n\n${HEADER_FORMAT}\n\n` +
    "Paths are from the project root. If one is not a model, such as a module another extends, leave it as it is.";
}
