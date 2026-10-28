import type * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BranchEntry, EntryDraft, ExtensionAPI, ExtensionContext, SettleEvent, SettleResult } from "./contract.js";
import { clarificationText, type Clarification, type RequestInput } from "./clarification.js";
import { type ChangeStatus, type ChangedFile, changedLines } from "./diff-lines.js";
import { currentContent, type Evidence } from "./evidence.js";
import { git, gitOutput, gitStopped, headCommit } from "./git.js";
import { engineName } from "./engine-name.js";
import { host } from "./host.js";
import type { ModelCheck } from "./model-check.js";
import { openCases } from "./open-cases.js";
import { roleModel } from "./verification/role-model-rule.js";
import { type AttemptEnd, GateOperations, type OperationSink, type OperationSpec } from "./operations.js";
import type { ContractStrength } from "./proof-guarantees.js";
import type { JudgmentContext } from "./pi-claimcheck.js";
import type { RequestJudgment } from "./receipt.js";
import { inFolder, owningProjects, suggestChecks } from "./projects.js";
import { proofReport } from "./prove-tool.js";
import { entryReceipt, type FloorRefusal, inUnit, isReceipt, type ModelResult, noEvidence, type Receipt, type ReceiptChild, receiptEntry, receiptGraphEntry,
  type UnitEvidence } from "./receipt.js";
import { attributionResolved, captureFingerprint, compareFingerprints, type Fingerprint, historyFacts, pathBlobs, refTips, type UnmeasuredPath } from "./request-fingerprint.js";
import { takeSnapshot } from "./snapshot.js";
import type { Against, CommandRun } from "./test-rung.js";
import type { FileChange } from "./verification-changes.js";
import type { Readiness } from "./verification/footer-rule.js";
import { commandVerdict, gateVerdict, keepsWorking, toolMayChangeFiles } from "./verification/gate-rule.js";
import { annotations, proofSources, proveFile } from "./verification/lemmascript-verifier.js";
import { checksModel } from "./verification/model-rule.js";
import { type Unit, workspaceUnits } from "./workspace.js";

/**
 * One step of verification, which the operator's stop interrupts: its signal
 * is aborted and the step is awaited, so what it started, a check's
 * processes or Dafny's, has stopped before the gate reports. `Effect.promise`
 * alone would let the gate report while they still run.
 */
function step<A>(work: (signal: AbortSignal) => Promise<A>): Effect.Effect<A> {
  return effect().callback<A>((resume) => {
    const controller = new AbortController();
    const running = work(controller.signal);
    running.then((value) => { resume(effect().succeed(value)); }, (error: unknown) => { resume(effect().die(error)); });
    return effect().promise(() => {
      controller.abort();
      return running.then(() => undefined, () => undefined);
    });
  });
}

/**
 * The gate's checks, and Effect, which runs them, once a run has first settled
 * (`gate-checks.ts`): settling loads them before anything uses them, so
 * neither weighs on a session that has not settled yet.
 */
let loaded: typeof import("./gate-checks.js") | undefined;
async function loadChecks(): Promise<void> {
  loaded ??= await import("./gate-checks.js");
}
function checks(): typeof import("./gate-checks.js") {
  if (loaded === undefined) throw new Error("The gate used its checks before settling loaded them.");
  return loaded;
}
/** Effect's functions, loaded with the checks. */
function effect(): typeof import("./gate-checks.js")["gateEffect"] {
  if (loaded === undefined) throw new Error("The gate used Effect before settling loaded it.");
  return loaded.gateEffect;
}

async function gitPaths(root: string, args: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
  return (await git(root, [...args, "-z"], undefined, signal))?.split("\0").filter((path) => path !== "");
}

/** `git diff` from `base`, relative to the project, as this module reads it whatever the operator's Git configuration. */
function diffFrom(base: string, ...options: string[]): string[] {
  return ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--relative", "--src-prefix=a/", "--dst-prefix=b/", ...options, base];
}

/**
 * The files under `root` that differ from the commit `base` or are
 * untracked, relative to it; every tracked file when `base` is null, before
 * the repository's first commit. A commit made since `base` hides nothing.
 * Deleted files are left out, and so is everything outside a Git repository
 * (`undefined`), or once `signal` stops Git.
 */
export async function changedFiles(root: string, base: string | null, signal?: AbortSignal): Promise<string[] | undefined> {
  const tracked = base === null ? await gitPaths(root, ["ls-files", "--cached"], signal)
    : await gitPaths(root, diffFrom(base, "--name-only", "--diff-filter=d"), signal);
  const untracked = await gitPaths(root, ["ls-files", "--others", "--exclude-standard"], signal);
  return tracked === undefined || untracked === undefined ? undefined : [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Each file changed during the request, as the run leaves it: the blob id Git would
 * store for its content, or null once deleted; `unreadable` when Git cannot
 * tell. A pull request's commit holds the receipt's content exactly where its
 * blobs match (`changedAfter`).
 */
async function recordedChanges(root: string, changed: readonly string[], signal?: AbortSignal): Promise<Receipt["changed"]> {
  const prefix = await git(root, ["rev-parse", "--show-prefix"], undefined, signal);
  if (prefix === undefined) return "unreadable";
  const blobs = await pathBlobs(root, changed, prefix.trimEnd(), signal);
  return blobs === undefined ? "unreadable" : [...blobs].map(([path, blob]) => ({ path, blob }))
    .sort((a, b) => a.path < b.path ? -1 : 1);
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch { return undefined; }
}

const statuses: Readonly<Record<string, ChangeStatus>> = { A: "added", D: "deleted" };

/** The diff from `base` and its files, or why the gate cannot read it. */
async function diffFromBase(root: string, base: string): Promise<ChangedFile[] | Exclude<Receipt["weakened"], readonly unknown[]>> {
  const listed = await gitOutput(root, [...diffFrom(base, "--name-status"), "-z"]);
  const diff = await gitOutput(root, diffFrom(base, "--unified=0"));
  if (listed === "too_large" || diff === "too_large") return "too_large";
  if (listed === undefined || diff === undefined) return "unreadable";
  const fields = listed.split("\0");
  const changes: Pick<ChangedFile, "path" | "status">[] = [];
  for (let k = 0; k + 1 < fields.length; k += 2) {
    changes.push({ path: fields[k + 1] ?? "", status: statuses[fields[k] ?? ""] ?? "modified" });
  }
  return changedLines(diff, changes);
}

/**
 * Each changed file's lines from `base`, with its content where the
 * weakening rules need it (`needsContent`) and the comment-only lines a
 * grammar reads in it (`withGrammarComments`), or why the change could not be
 * read. A changed file the base lacks, untracked or before the first commit,
 * counts as added whole.
 */
async function fileChanges(root: string, base: string | null, changed: readonly string[]):
  Promise<FileChange[] | Exclude<Receipt["weakened"], readonly unknown[]>> {
  const diffed = base === null ? [] : await diffFromBase(root, base);
  if (typeof diffed === "string") return diffed;
  const inDiff = new Set(diffed.map(({ path }) => path));
  // A proof's last generated program: `lsc regen` rewrites it from the source and drops from the proof what it no longer generates.
  const generated = (path: string): Promise<string | undefined> =>
    path.endsWith(".dfy") ? readIfPresent(join(root, `${path}.gen`)) : Promise.resolve(undefined);
  const whole = await Promise.all(changed.filter((path) => !inDiff.has(path)).map(async (path): Promise<FileChange> => {
    const content = await readIfPresent(join(root, path));
    return { path, status: "added", removed: [], content, generated: await generated(path),
      added: content?.split(/\r?\n/u).map((text, k) => ({ number: k + 1, text })) ?? [] };
  }));
  const read = await Promise.all(diffed.map(async (file): Promise<FileChange> => base === null || !checks().needsContent(file) ? file
    : { ...file, content: await readIfPresent(join(root, file.path)), baseContent: await git(root, ["show", `${base}:./${file.path}`]),
      generated: await generated(file.path) }));
  return (await Promise.all([...read, ...whole].map(checks().withGrammarComments))).sort((a, b) => a.path < b.path ? -1 : 1);
}

async function hasAnnotations(root: string, path: string): Promise<boolean> {
  try { return annotations(await readFile(join(root, path), "utf8")).length > 0; } catch { return false; }
}

/**
 * The changed TypeScript files with `//@` contracts, and those whose `.dfy`
 * proof changed, wherever LemmaScript keeps it (`proofSources`), since a
 * proof's hand-written lines are part of what it proves.
 */
async function contractFiles(root: string, changed: readonly string[], signal: AbortSignal): Promise<string[]> {
  const sources = new Set(changed.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts")));
  // A source found already is not asked about again (`proofSources`).
  for (const path of changed.filter((changedPath) => /\.dfy(\.gen)?$/u.test(changedPath))) {
    for (const source of await proofSources(root, path, signal, sources)) sources.add(source);
  }
  const files: string[] = [];
  for (const path of [...sources].sort()) if (await hasAnnotations(root, path)) files.push(path);
  return files;
}

/**
 * What a failing command's correction must change before it goes back
 * again: the set of tests that fail, read from the JUnit reports it wrote;
 * the command itself when it wrote none, so that it goes back once, since a
 * run's output varies and cannot show a correction repeating a failure.
 */
function testFailure({ command, failingTests }: CommandRun): string {
  return failingTests === undefined ? command : `failing tests:\n${failingTests.join("\n")}`;
}

/**
 * The test rung (#342), once no proof goes back: the commands of the projects
 * that own the changed files (`suggestChecks`, `owningProjects`) run on the
 * change. A command that fails runs on the base too (`runCommands`), and a
 * failure the base already had stays from the agent (#726, `commandVerdict`);
 * any other goes back until it repeats one already sent back (`testFailure`). When every
 * command passes, each changed or added test runs over the request's base,
 * which shows whether it exercises the change.
 */
async function testRung(root: string, base: string | null, changed: readonly string[],
  sentBack: ReadonlyMap<string, readonly string[]>, signal: AbortSignal, ops: OperationSink,
  env: Readonly<Record<string, string>> | undefined, attributable: boolean, against: Against): Promise<Pick<Receipt, "tests" | "exercises">> {
  const projects = owningProjects(suggestChecks(root), changed);
  const tests = (await checks().runCommands(root, projects, changed, signal, ops, env, against)).map((run) => ({ ...run,
    verdict: commandVerdict(run.evidence.outcome, testFailure(run), sentBack.get(run.command) ?? [], run.origin?.cause === "preexisting") }));
  const passed = tests.every(({ evidence }) => evidence.outcome === "passed");
  // A snapshot or a fixture counts as a test for weakened evidence, but is not one a runner can run alone (#615).
  const runnable = changed.filter((path) => checks().isTestPath(path) && checks().isSourcePath(path));
  const present = (await Promise.all(runnable.map(async (path) => await readIfPresent(join(root, path)) === undefined ? [] : [path]))).flat();
  const exercises = attributable && passed && base !== null ? await checks().exerciseTests(root, base, present, changed, projects, signal, ops, env) : [];
  return { tests, exercises };
}

/**
 * What goes back to the agent for a failing command: the tests its reports
 * name, why Tesota can't tell whether the changes cause it when it can't,
 * then the end of its output.
 */
function failingReport({ command, failingTests, evidence, origin }: CommandRun): string {
  const names = failingTests === undefined || failingTests.length === 0 ? ""
    : `These tests fail:\n${failingTests.map((name) => `  ${name}`).join("\n")}\n\n`;
  const unknown = origin?.cause === "unknown" ? `Tesota can't tell whether your changes cause it: ${origin.reason}.\n\n` : "";
  return `Tesota: \`${command}\` fails with your changes.\n\n${unknown}${names}${evidence.output.trimEnd()}`;
}

/** What a unit's failing commands are compared with: its base, or why a run there would not show the request's start. */
function comparedWith(unit: ChangedUnit, attributable: boolean): Against {
  if (unit.base === null) return { unfaithful: "there is no base to run it on" };
  if (unit.snapshot !== undefined) return { unfaithful: "the folder is no Git repository, so its start can't be checked out to run it on" };
  if (!attributable) return { unfaithful: "other work moved the repository during the request, so the base may not be its start" };
  if (unit.inherited.length > 0) return { unfaithful: `the request started with changes the base doesn't hold: ${unit.inherited.join(", ")}` };
  return { base: unit.base };
}

/** The files that proved, as changed and at the request's base, whose contracts and covered lines the receipt measures. */
async function provedSources(root: string, base: string | null, proofs: Receipt["proofs"]): Promise<ProvedSource[]> {
  return Promise.all(proofs.filter(({ verdict }) => verdict === "proved").map(async ({ path, evidence }) => ({ path,
    checked: evidence.files, source: await readIfPresent(join(root, path)) ?? "",
    baseSource: base === null ? undefined : await git(root, ["show", `${base}:./${path}`]) })));
}

type ProvedSource = { readonly path: string; readonly checked: readonly string[]; readonly source: string;
  readonly baseSource: string | undefined };

/** The changed lines of each TypeScript file that proved that no contract's proof covers (`uncoveredLines`). */
function uncovered(sources: readonly ProvedSource[], changes: Awaited<ReturnType<typeof fileChanges>>,
  weakened: Receipt["weakened"]): Receipt["uncovered"] {
  if (typeof changes === "string" || typeof weakened === "string") return [];
  const byPath = new Map(changes.map((change) => [change.path, change]));
  return sources.flatMap(({ path, checked, source, baseSource }) => {
    const change = byPath.get(path);
    return change === undefined || !path.endsWith(".ts") ? [] : [checks().uncoveredLines(change, checked, source, baseSource, weakened)];
  });
}

/**
 * Whether a file's change holds no code: it added or removed lines, and each
 * is blank or only a comment (`commentLines`). A file whose lines Git did
 * not show, binary or with a change too large to read, may hold code.
 */
function onlyComments(change: FileChange | undefined): boolean {
  if (change === undefined) return false;
  const comments = checks().commentLines(change);
  const blank = ({ text }: { text: string }): boolean => text.trim() === "";
  return change.added.length + change.removed.length > 0 && change.added.every((line) => blank(line) || comments.added(line)) &&
    change.removed.every((line) => blank(line) || comments.removed(line));
}

/**
 * The changed files no proof covers (`covered`), other than test files and
 * files whose change holds no code (`onlyComments`), and whether no file's
 * change held any.
 */
function unprovedFiles(changes: Awaited<ReturnType<typeof fileChanges>>, changed: readonly string[],
  covered: ReadonlySet<string>): Pick<Receipt, "unverified" | "commentsOnly"> {
  const read = typeof changes === "string" ? [] : changes;
  const unverified = changed.filter((path) => !covered.has(path) && !checks().isTestPath(path) &&
    !onlyComments(read.find((file) => file.path === path)));
  return read.length > 0 && read.every(onlyComments) ? { unverified, commentsOnly: true } : { unverified };
}

/** The Pi flag that names ClaimCheck's second model (`claimCheck`). */
const claimcheckModelFlag = "claimcheck-model";

function restateWith(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
  const selected = selectedRoleModel(pi, ctx, claimcheckModelFlag, host().verificationModels().claimcheckModel);
  // The session's own model restates as itself, without a registry lookup.
  return ctx.model !== undefined && selected === `${ctx.model.provider}/${ctx.model.id}` ? undefined : selected;
}

/** One precedence owner for both model-judged roles; no session model is an empty selection. */
function selectedRoleModel(pi: ExtensionAPI, ctx: ExtensionContext, flag: string, setting: string | undefined): string | undefined {
  const value = pi.getFlag(flag);
  const selected = roleModel(typeof value === "string" ? value : "", setting ?? "",
    ctx.model === undefined ? "" : `${ctx.model.provider}/${ctx.model.id}`);
  return selected === "" ? undefined : selected;
}

/** The Pi flag that names the model listing the cases a request leaves open (`openCases`), or `off`. */
const openCasesModelFlag = "open-cases-model";

/** The model that lists open cases; undefined when explicitly turned off. */
function listWith(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
  const selected = selectedRoleModel(pi, ctx, openCasesModelFlag, host().verificationModels().openCasesModel);
  // No selected session model still produces a receipt reason through openCases.
  return selected === "off" ? undefined : selected ?? "";
}

/** What a weak contract's correction must change before it goes back again: the changes to its code that still prove. */
function weakFailure({ mutation }: ContractStrength): string {
  return mutation.survived.map(({ line, before, after }) => `${line}: ${before} -> ${after}`).join("\n");
}

/** What goes back to the agent for a weak contract: the changes to its code its proof does not rule out. */
function weakContractReport({ path, name, mutation }: ContractStrength): string {
  return `Tesota: the contract of ${name} in ${path} proves, but these changes to its code prove too, so it does not rule ` +
    `them out:\n${mutation.survived.map(({ line, before, after }) => `  line ${line}: ${before} became ${after}`).join("\n")}\n\n` +
    "Strengthen the contract so its proof rules out what the request does not allow, and keep it provable. " +
    "A change that behaves the same as the code needs nothing.";
}

/**
 * The weak contracts that go back, each until its surviving changes repeat
 * ones already sent back (`gateVerdict`), recorded in `sentBack`.
 */
function sendBackWeak(strength: readonly ContractStrength[], sentBack: Map<string, string[]>): ContractStrength[] {
  const key = ({ path, name }: ContractStrength): string => `${path}#${name}`;
  const weak = strength.filter((item) => item.mutation.survived.length > 0
    && gateVerdict("failed", weakFailure(item), sentBack.get(key(item)) ?? []) === "send_back");
  for (const item of weak) sentBack.set(key(item), [...sentBack.get(key(item)) ?? [], weakFailure(item)]);
  return weak;
}

/**
 * What one round sent back to the agent, as the `details` of its
 * `tesota-gate` entry: the proofs that do not prove yet, the commands that
 * fail, or the contracts too weak to trust. The entry's text is what the
 * agent reads; these are for the operator's view of it.
 */
export type SentBack =
  | { readonly round: "proofs"; readonly proofs: readonly { readonly path: string; readonly evidence: Evidence }[] }
  | { readonly round: "tests"; readonly commands: readonly CommandRun[] }
  | { readonly round: "contracts"; readonly contracts: readonly ContractStrength[] }
  | { readonly round: "models"; readonly models: readonly ModelCheck[]; readonly unheaded: readonly string[] };

/** The session's model as the receipt records it, when one is set. */
function sessionModel(ctx: Pick<ExtensionContext, "model">): Pick<Receipt, "model"> {
  return ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` };
}

/** What the gate's current round found so far: proofs, then the commands, then weak contracts. */
export interface Tally {
  readonly proved: number;
  readonly notProved: number;
  readonly tests?: "pass" | "fail";
  readonly weak?: number;
}

/**
 * What the gate is doing, for the footer. Between requests it is ready with
 * what the project lets it verify, and `waiting` while the agent works on
 * the operator's request, before anything settles. While a run settles it is proving,
 * testing or measuring contracts; it has `sent_back` failures while the
 * agent answers them, and is `settled` once the run ends with a receipt.
 */
export type GateStatus =
  | { readonly step: "ready"; readonly readiness: Readiness }
  | { readonly step: "waiting"; readonly readiness: Readiness }
  | { readonly step: "proving"; readonly path: string; readonly startedAt: number; readonly tally: Tally }
  | { readonly step: "testing" | "measuring"; readonly startedAt: number; readonly tally: Tally }
  | { readonly step: "checking"; readonly path: string; readonly startedAt: number; readonly tally: Tally }
  | { readonly step: "sent_back"; readonly tally: Tally }
  | { readonly step: "settled"; readonly receipt: Receipt };

/** The round so far: the proofs judged, then whether every command passed, then how many contracts are weak. */
function tally(proofs: Receipt["proofs"], tests?: Receipt["tests"], contracts?: readonly ContractStrength[]): Tally {
  const proved = proofs.filter(({ verdict }) => verdict === "proved").length;
  const passed = tests?.every(({ evidence }) => evidence.outcome === "passed");
  return { proved, notProved: proofs.length - proved, ...tests === undefined || tests.length === 0 ? {} : { tests: passed ? "pass" : "fail" },
    ...contracts === undefined ? {} : { weak: contracts.filter(({ mutation }) => mutation.survived.length > 0).length } };
}

/** The gate's status and who listens to it; the gate alone changes it. */
export class GateProgress {
  /** The operations the gate and its runners publish (#590); the status line reads them. */
  readonly operations: GateOperations = new GateOperations();
  #readiness: Readiness = "nothing";
  #status: GateStatus = { step: "ready", readiness: "nothing" };
  readonly #listeners = new Set<() => void>();

  get status(): GateStatus { return this.#status; }

  /** Calls `listener` on every change, until the returned function is called. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** What the project lets Tesota verify, shown whenever no request has evidence to show. */
  ready(readiness: Readiness): void {
    this.#readiness = readiness;
    this.publish({ step: "ready", readiness });
  }

  /**
   * The receipt a resumed session settled with, when no request came after
   * it: the last `tesota-receipt` entry on the branch, unless the operator
   * spoke later. Otherwise the status stays as it is.
   */
  resume(branch: readonly BranchEntry[]): void {
    const at = branch.findLastIndex((entry) => entryReceipt(entry) !== undefined);
    const request = branch.findLastIndex((entry) => entry.type === "message" && entry.message?.role === "user");
    const entry = branch[at];
    const receipt = at > request && entry !== undefined ? entryReceipt(entry) : undefined;
    if (isReceipt(receipt)) this.publish({ step: "settled", receipt });
  }

  /** Back to ready, as on the operator's next request. */
  reset(): void { this.publish({ step: "ready", readiness: this.#readiness }); }

  /** Waiting for the agent, from the operator's request until the run settles. */
  waiting(): void { this.publish({ step: "waiting", readiness: this.#readiness }); }

  publish(status: GateStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * The gate (#339): before a completed run settles, it proves every changed
 * file with contracts. A failed or vacuous proof goes back to the agent and
 * the run continues, until the agent repeats any failure the gate already
 * sent back for that file (`gateVerdict`). Then the test rung runs
 * (`testRung`), and once it passes, the strength of the contracts the
 * request added or changed (`contractStrength`) and the changed lines no
 * proof covers (`uncovered`) are measured for the receipt, and a weak
 * contract goes back first (`sendBackWeak`). Then each model the request
 * touched is checked with TLC (`checkModels`), and one that fails, or a model
 * file without a header, goes back. What went back lasts for the operator's request: it resets on their input, not
 * on `agent_start`, which every continuation fires too. When nothing goes back, the run settles with
 * a receipt for the operator. The first non-reader tool fingerprints each
 * repository; paths changed since then and commits since admission are the
 * observed comparison set. Weakening keeps admission H; history movement the
 * request cannot be shown to own withholds exercise and contract-intent credit,
 * never current-checkout checks.
 * A commit hides nothing; a steer or follow-up sent while the agent works belongs to
 * the request already running. Outside a Git repository the base is
 * Tesota's snapshot of the folder (`takeSnapshot`, #384); where it takes
 * none, a request that ran a tool that may change files ends with a receipt
 * that says why nothing was verified. In a folder of repositories that is in
 * none, each repository and each other folder the request changed goes
 * through these steps from its own base and folder, each round gathering
 * what goes back across them, and the receipt holds each one as a unit.
 * On `@tesota/core` the gate is the session's verifier and reads the
 * request, its amendments and its bases from the ledger (`recorded`, #439)
 * instead of capturing them; on Pi it captures them on the operator's input.
 * A run that ends before it completes, after a tool that may change files,
 * settles with a receipt that says nothing was verified and why.
 */
export function registerGate(pi: ExtensionAPI, recorded?: () => RecordedRequest | undefined): GateProgress {
  const progress = new GateProgress();
  pi.registerFlag(claimcheckModelFlag, { type: "string",
    description: "The provider/id of ClaimCheck's restating model; overrides settings.claimcheckModel, then the session's model" });
  pi.registerFlag(openCasesModelFlag, { type: "string",
    description: "The provider/id of the open-cases model, or off; overrides settings.openCasesModel, then the session's model" });
  /** What went back, by path or by contract as seen from the folder Pi runs in, and by command within each repository's folder. */
  let sentBack = new Map<string, string[]>();
  let commandsSentBack = new Map<string, Map<string, string[]>>();
  let weakSentBack = new Map<string, string[]>();
  let modelsSentBack = new Map<string, string[]>();
  let unheadedSentBack = new Set<string>();
  /**
   * Each model's last check in the request and last passing check in the
   * session, by its path from the folder Pi runs in: the same content is never
   * checked again, and a repeated failure is judged without running TLC.
   */
  let modelsChecked = new Map<string, ModelCheck>();
  const modelsPassed = new Map<string, ModelCheck>();
  let mayHaveChanged = false;
  let fingerprints: Promise<ReadonlyMap<string, Fingerprint>> | undefined;
  /** What the operator asked during the request, for ClaimCheck to compare the contracts with. */
  let requests: string[] = [];
  let judgingRequests: RequestJudgment["requests"] = [];
  let requestJudgments: RequestJudgment[] = [];
  const judging = (folder = ""): JudgmentContext => ({ folder, requests: judgingRequests, record: (judgment) => { requestJudgments.push(judgment); } });
  const judgedContext = (): Pick<Receipt, "requestJudgments"> => requestJudgments.length === 0 ? {} : { requestJudgments };
  let clarifications: readonly Clarification[] = [];
  /** The subagents the request started (#525), as the ledger recorded their ends. */
  let children: readonly ReceiptChild[] = [];
  let floorRefusals: readonly FloorRefusal[] = [];
  /** The request's units and bases, recorded before the agent can run anything; a run no operator input started takes them as it settles. */
  let start: Promise<Start> | undefined;
  let startedAt: string | undefined;
  let requestNumber = 0;
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== undefined) {
      if (event.source !== "extension") requests.push(event.text);
      return undefined;
    }
    sentBack = new Map();
    commandsSentBack = new Map();
    weakSentBack = new Map();
    modelsSentBack = new Map();
    unheadedSentBack = new Set();
    modelsChecked = new Map();
    mayHaveChanged = false;
    fingerprints = undefined;
    clarifications = [];
    children = [];
    floorRefusals = [];
    start = undefined;
    // A request that continues one that ended on its question (#651) is measured from that one's start: what it changed is its own.
    const restored = restoredStart(recorded?.()?.continues?.start);
    if (restored !== undefined) {
      fingerprints = Promise.resolve(restored);
      mayHaveChanged = true;
    }
    progress.operations.beginRun(`request-${requestNumber += 1}`);
    progress.waiting();
    // On the engine the ledger holds the request and its start; the gate reads them as it settles.
    if (recorded !== undefined) return undefined;
    requests = [event.text];
    startedAt = new Date().toISOString();
    start = begin(ctx.cwd);
    await start;
    return undefined;
  });
  pi.on("tool_execution_start", async (event, ctx) => {
    if (!toolMayChangeFiles(event.toolName, event.nativeQuestion === true, event.readOnly === true)) return;
    mayHaveChanged = true;
    const request = recorded?.();
    if (request !== undefined) start ??= Promise.resolve(recordedStart(request.base));
    fingerprints ??= (async () => {
      const units = (await start)?.units ?? workspaceUnits(ctx.cwd);
      return new Map(await Promise.all(units.filter(({ repository }) => repository)
        .map(async ({ folder }) => [folder, await captureFingerprint(join(ctx.cwd, folder))] as const)));
    })();
    await fingerprints;
  });
  // A run that ends before verification leaves no step running, and says why if it may have changed files.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (!mayHaveChanged) { progress.reset(); return undefined; }
    await loadChecks();
    requestJudgments = [];
    const request = recorded?.();
    if (request !== undefined) {
      // Only a receipt that verified changes ends the chain, not a tool-free answer (#627).
      judgingRequests = judgedRequests(request, requestNumber);
      requests = judgingRequests.flatMap(({ text }) => text);
      clarifications = request.inputs.flatMap((input) => input.kind === "clarification" ? [input.clarification] : []);
      children = request.children ?? [];
      floorRefusals = request.refusals ?? [];
      startedAt = request.at;
      start = Promise.resolve(recordedStart(request.base));
    }
    if (request === undefined) judgingRequests = [{ run: requestNumber, text: requests }];
    // One pass over the request: it closes as returned to the agent, settled or stopped, whatever it published.
    progress.operations.beginAttempt();
    let closed: AttemptEnd = "stopped";
    try {
      const result = await verify(event, ctx);
      closed = result?.continue === true ? "returned_to_agent"
        : event.outcome !== "completed" || ctx.signal?.aborted === true ? "stopped" : "settled";
      // A run that ends on its question keeps its start fingerprints, for the run that answers it to restore (#651).
      const prints = event.outcome === "completed" && event.reason !== undefined && result?.continue !== true ? await fingerprints : undefined;
      return prints === undefined ? result : { ...result, entries: [...result?.entries ?? [], savedStart(prints)] };
    } finally { progress.operations.closeAttempt(closed); }
  });
  const verify = async (event: SettleEvent, ctx: ExtensionContext): Promise<SettleResult | undefined> => {
    if (event.outcome !== "completed") {
      const reason = "reason" in event && typeof event.reason === "string" ? event.reason : undefined;
      return stopped(ctx, reason ?? (event.outcome === "aborted" ? "the operator stopped the run before Tesota verified it"
        : "the run failed before Tesota verified it"));
    }
    // Verification is an Effect the operator's stop interrupts (#408): no later step starts, and the receipt says it stopped.
    try {
      return await effect().runPromise(settle(ctx, event.reason === undefined ? {} : { unresolvedQuestion: event.reason }), ctx.signal === undefined ? {} : { signal: ctx.signal });
    } catch (error) {
      if (ctx.signal?.aborted === true) {
        return stopped(ctx, `the operator stopped the run while Tesota verified it; ${cutShort(progress.operations.unfinished())}`);
      }
      progress.reset();
      throw error;
    }
  };
  /**
   * A run that ended before verification finished: after a tool that may
   * change files, a receipt that verified nothing, why, and an inventory of
   * what the run left (#599), read and never checked, or why it could not be read.
   */
  const stopped = async (ctx: ExtensionContext, reason: string): Promise<SettleResult | undefined> => {
    if (!mayHaveChanged) {
      if (progress.status.step === "waiting" || "startedAt" in progress.status) progress.reset();
      return undefined;
    }
    const begun = await start;
    const workspace = begun?.units.some(({ folder }) => folder !== "") ?? false;
    const at = startedAt ?? new Date().toISOString();
    // A stuck Git or a slow drive must not hold the stop: past the limit the inventory is abandoned, and says so. Its Git
    // is stopped, with every process it started, before the stop reports.
    const reading = new AbortController();
    const inventory = await effect().runPromise(effect().map(effect().timeoutOption(
      effect().promise(async () => stoppedInventory(ctx.cwd, begun, await fingerprints, at, reading.signal)), STOP_INVENTORY_TIME_LIMIT_MS),
    (read) => read._tag === "Some" ? read.value
      : { changed: "unreadable" as const, lines: "unreadable" as const, reason: "the inventory ran past its time limit" }));
    reading.abort();
    await gitStopped(reading.signal);
    const receipt: Receipt = { version: 2,
      repository: begun?.units.some(({ folder, repository }) => repository && begun.bases.has(folder)) ?? false,
      base: workspace ? null : begun?.bases.get("") ?? null, startedAt: at,
      settledAt: new Date().toISOString(), engine: await engineName(), ...sessionModel(ctx), ...noEvidence,
      ...inventory, stopped: reason,
      ...clarifications.length === 0 ? {} : { clarifications }, ...children.length === 0 ? {} : { children },
      ...floorRefusals.length === 0 ? {} : { floorRefusals } };
    progress.publish({ step: "settled", receipt });
    return { entries: [receiptEntry(ctx.mode, receipt)] };
  };
  /** Outside Git nothing tells which files changed: a request that may have changed some settles saying none was verified. */
  const outsideGit = (ctx: ExtensionContext, run: Pick<Receipt, "base" | "startedAt" | "engine" | "model" | "clarifications" | "children" | "floorRefusals">,
    reason: string | undefined): SettleResult | undefined => {
    if (!mayHaveChanged) return undefined;
    const receipt: Receipt = { version: 2, repository: false, ...run, settledAt: new Date().toISOString(), ...noEvidence,
      ...reason === undefined ? {} : { reason } };
    progress.publish({ step: "settled", receipt });
    return { entries: [receiptEntry(ctx.mode, receipt)] };
  };
  /** The cases the request leaves open, for the receipt; nothing when the operator turned the list off. */
  const listOpen = (ctx: ExtensionContext): Effect.Effect<Pick<Receipt, "openCases">> => {
    const lister = listWith(pi, ctx);
    return lister === undefined ? effect().succeed({})
      : effect().map(step((signal) => progress.operations.run({ method: "open_cases", unit: "", target: lister },
        () => openCases(ctx, requests, lister, signal, judging()), () => "done")), (listed) => ({ openCases: listed }));
  };
  const failure = (proof: Evidence): string => `${proof.outcome}\n${proof.output}`;
  const sendBack = (content: string, details: SentBack): SettleResult =>
    ({ entries: [{ type: "custom_message", customType: "tesota-gate", content, display: true, details }], continue: true });
  /** Every changed file with contracts proved, in each repository from its own folder. */
  const prove = (units: readonly ChangedUnit[]): Effect.Effect<Map<string, Receipt["proofs"][number][]>> => effect().gen(function* () {
    const proofs = new Map<string, Receipt["proofs"][number][]>(units.map(({ folder }) => [folder, []]));
    for (const unit of units) {
      const files = yield* step((signal) => contractFiles(unit.root, unit.changed, signal));
      const ops = progress.operations.forUnit(unit.folder);
      // What LemmaScript launches for a file: `lsc regen`, then `lsc check` (`proveFile`).
      const spec = (path: string): OperationSpec => ({ method: "proof", unit: unit.folder, target: `lsc regen && lsc check --backend=dafny ${path}` });
      const planned = files.map((path) => ops.plan(spec(path)));
      for (const [k, path] of files.entries()) {
        progress.publish({ step: "proving", path: inUnit(unit.folder, path), startedAt: performance.now(),
          tally: tally([...proofs.values()].flat()) });
        const evidence = yield* step((signal) => ops.run(spec(path), () => proveFile(unit.root, path, signal),
          (proved) => proved.outcome, planned[k]));
        proofs.get(unit.folder)?.push({ path, evidence,
          verdict: gateVerdict(evidence.outcome, failure(evidence), sentBack.get(inUnit(unit.folder, path)) ?? []) });
      }
    }
    return proofs;
  });
  /** The proofs that go back, named from the folder Pi runs in. */
  const proofsBack = (proofs: ReadonlyMap<string, Receipt["proofs"]>, finalizing: boolean): SettleResult | undefined => {
    if (finalizing || !keepsWorking([...proofs.values()].flat().map(({ verdict }) => verdict))) return undefined;
    progress.publish({ step: "sent_back", tally: tally([...proofs.values()].flat()) });
    const back = [...proofs].flatMap(([folder, judged]) => judged.filter(({ verdict }) => verdict === "send_back")
      .map(({ path, evidence }) => ({ path: inUnit(folder, path), evidence })));
    for (const { path, evidence } of back) sentBack.set(path, [...sentBack.get(path) ?? [], failure(evidence)]);
    const proveActive = pi.getActiveTools().includes("prove");
    return sendBack(back.map(({ path, evidence }) =>
      `Tesota: ${path} does not prove yet.\n\n${proofReport(path, evidence, proveActive)}`).join("\n\n"), { round: "proofs", proofs: back });
  };
  /** The failing commands that go back, each run from its repository's folder. */
  const testsBack = (failing: readonly { folder: string; run: CommandRun }[], tallied: Tally, finalizing: boolean): SettleResult | undefined => {
    if (finalizing || failing.length === 0) return undefined;
    progress.publish({ step: "sent_back", tally: tallied });
    for (const { folder, run } of failing) {
      const sent = commandsSentBack.get(folder) ?? new Map<string, string[]>();
      sent.set(run.command, [...sent.get(run.command) ?? [], testFailure(run)]);
      commandsSentBack.set(folder, sent);
    }
    const shown = failing.map(({ folder, run: { command, evidence, failingTests, origin } }): CommandRun =>
      ({ command: inFolder(folder, command), evidence, ...failingTests === undefined ? {} : { failingTests }, ...origin === undefined ? {} : { origin } }));
    return sendBack(shown.map(failingReport).join("\n\n"), { round: "tests", commands: shown });
  };
  /** The strength of each repository's contracts that proved, and what its proofs covered. */
  const measure = (ctx: ExtensionContext, units: readonly ChangedUnit[], proofs: ReadonlyMap<string, Receipt["proofs"]>,
    tallied: Tally): Effect.Effect<Map<string, Measured>> => effect().gen(function* () {
    const measured = new Map<string, Measured>();
    for (const unit of units) {
      const judged = proofs.get(unit.folder) ?? [];
      const sources = yield* step(() => provedSources(unit.root, unit.base, judged));
      if (sources.length > 0) progress.publish({ step: "measuring", startedAt: performance.now(), tally: tallied });
      const strength = attributionResolved(unit.base, unit.startState, unit.endState, unit.snapshot === undefined)
        ? yield* step((signal) => checks().contractStrength(ctx, requests, sources, signal, restateWith(pi, ctx),
          progress.operations.forUnit(unit.folder), judging(unit.folder))) : { contracts: [] };
      measured.set(unit.folder, { sources, strength });
    }
    return measured;
  });
  /**
   * Each repository's models the request touched, checked once per content
   * (`checksModel`): a model whose last check in the request, or last passing
   * check in the session, read exactly this content keeps that check, judged
   * again against what went back. With them, the TLA+ and Quint files the
   * request changed that declare no header.
   */
  const checkModels = (units: readonly ChangedUnit[], tallied: Tally, env: Readonly<Record<string, string>> | undefined,
    sessionFile: string | undefined):
    Effect.Effect<Map<string, ModelRung>> => effect().gen(function* () {
    const rungs = new Map<string, ModelRung>();
    for (const unit of units) {
      const planned = yield* step(() => checks().plannedModels(unit.root, unit.changed));
      const models: ModelResult[] = [];
      for (const plan of planned.models) {
        const key = inUnit(unit.folder, plan.path);
        const earlier = [modelsChecked.get(key), modelsPassed.get(key)].find((check) => check?.evidence.contentHash === plan.contentHash);
        const judged = (check: ModelCheck): ModelResult =>
          ({ ...check, verdict: gateVerdict(check.evidence.outcome, checks().modelFailure(check), modelsSentBack.get(key) ?? []) });
        if (!checksModel(plan.touched, earlier !== undefined)) {
          if (plan.touched && earlier !== undefined) {
            progress.operations.reused({ method: "model_main", unit: unit.folder, target: plan.path }, earlier.evidence.outcome);
            models.push(judged(earlier));
          }
          continue;
        }
        progress.publish({ step: "checking", path: key, startedAt: performance.now(), tally: tallied });
        const check = yield* step((signal) => checks().checkModel(unit.root, plan.path, unit.changed, signal, undefined,
          progress.operations.forUnit(unit.folder), env, sessionFile === undefined ? undefined : { sessionFile }));
        modelsChecked.set(key, check);
        if (check.evidence.outcome === "passed") modelsPassed.set(key, check);
        models.push(judged(check));
      }
      rungs.set(unit.folder, { models, unheaded: planned.unheaded });
    }
    return rungs;
  });
  /** The models that go back, and the files without a header not yet sent back in this request, named from the folder Pi runs in. */
  const modelsBack = (rungs: ReadonlyMap<string, ModelRung>, tallied: Tally, finalizing: boolean): SettleResult | undefined => {
    if (finalizing) return undefined;
    const back = [...rungs].flatMap(([folder, { models }]) => models.filter(({ verdict }) => verdict === "send_back")
      .map((model) => ({ ...model, path: inUnit(folder, model.path) })));
    const unheaded = [...rungs].flatMap(([folder, rung]) => rung.unheaded.map((path) => inUnit(folder, path)))
      .filter((path) => !unheadedSentBack.has(path));
    if (back.length === 0 && unheaded.length === 0) return undefined;
    progress.publish({ step: "sent_back", tally: tallied });
    for (const model of back) modelsSentBack.set(model.path, [...modelsSentBack.get(model.path) ?? [], checks().modelFailure(model)]);
    for (const path of unheaded) unheadedSentBack.add(path);
    return sendBack([...back.map(checks().modelReport), ...unheaded.length === 0 ? [] : [checks().unheadedReport(unheaded)]].join("\n\n"),
      { round: "models", models: back, unheaded });
  };
  /** Weak contracts go back only while generation can continue. */
  const contractsBack = (contracts: readonly ContractStrength[], tallied: Tally, finalizing: boolean): SettleResult | undefined => {
    if (finalizing) return undefined;
    const weak = sendBackWeak(contracts, weakSentBack);
    if (weak.length === 0) return undefined;
    progress.publish({ step: "sent_back", tally: tallied });
    return sendBack(weak.map(weakContractReport).join("\n\n"), { round: "contracts", contracts: weak });
  };
  /** Verification once the run completed: each step is where the operator's stop takes effect. */
  const settle = (ctx: ExtensionContext, question: Pick<Receipt, "unresolvedQuestion">): Effect.Effect<SettleResult | undefined> => effect().gen(function* () {
    const { unresolvedQuestion } = question;
    const { units, bases, refs, tooLarge, refused } = yield* step(() => start ??= begin(ctx.cwd));
    startedAt ??= new Date().toISOString();
    const engine = yield* effect().promise(engineName);
    const workspace = units.some(({ folder }) => folder !== "");
    const run = { base: workspace ? null : bases.get("") ?? null, startedAt, engine, ...sessionModel(ctx),
      ...question,
      ...clarifications.length === 0 ? {} : { clarifications }, ...children.length === 0 ? {} : { children },
      ...floorRefusals.length === 0 ? {} : { floorRefusals } };
    // Each repository and each folder Tesota snapshotted, measured from its base.
    const measurable = units.filter(({ folder }) => bases.has(folder));
    const initial = yield* step(async () => fingerprints);
    const read = yield* step(() => Promise.all(measurable.map(({ folder, repository }) =>
      changedUnit(ctx.cwd, folder, bases.get(folder) ?? null, repository ? undefined : tooLarge.get(folder) ?? [], initial?.get(folder), run.startedAt,
        refs.get(folder)))));
    if (!workspace && read[0] === undefined) return outsideGit(ctx, run, refused.get(""));
    const changed = read.filter((unit): unit is ChangedUnit => typeof unit === "object");
    // A folder with no snapshot, or a repository Git could not read, is not verified; it is listed once it may have changed.
    const plain = workspace && mayHaveChanged ? [...units.filter(({ folder }) => !bases.has(folder)),
      ...measurable.filter((_, k) => read[k] === undefined)] : [];
    if (changed.length === 0 && plain.length === 0) { progress.reset(); return undefined; }
    const proofs = yield* prove(changed);
    const allProofs = [...proofs.values()].flat();
    const proofsSent = proofsBack(proofs, unresolvedQuestion !== undefined);
    if (proofsSent !== undefined) return proofsSent;
    progress.publish({ step: "testing", startedAt: performance.now(), tally: tally(allProofs) });
    const rungs = new Map<string, Pick<Receipt, "tests" | "exercises">>();
    for (const unit of changed) {
      const attributable = attributionResolved(unit.base, unit.startState, unit.endState, unit.snapshot === undefined);
      rungs.set(unit.folder, yield* step((signal) =>
        testRung(unit.root, unit.base, unit.changed, commandsSentBack.get(unit.folder) ?? new Map(), signal,
          progress.operations.forUnit(unit.folder), ctx.env, attributable, comparedWith(unit, attributable))));
    }
    const allTests = [...rungs.values()].flatMap(({ tests }) => tests);
    const failing = [...rungs].flatMap(([folder, { tests }]) =>
      tests.filter(({ verdict }) => verdict === "send_back").map((test) => ({ folder, run: test })));
    const testsSent = testsBack(failing, tally(allProofs, allTests), unresolvedQuestion !== undefined);
    if (testsSent !== undefined) return testsSent;
    const measured = yield* measure(ctx, changed, proofs, tally(allProofs, allTests));
    const contracts = [...measured].flatMap(([folder, { strength }]) =>
      strength.contracts.map((contract) => ({ ...contract, path: inUnit(folder, contract.path) })));
    const contractsSent = contractsBack(contracts, tally(allProofs, allTests, contracts), unresolvedQuestion !== undefined);
    if (contractsSent !== undefined) return contractsSent;
    const modelRungs = yield* checkModels(changed, tally(allProofs, allTests, contracts), ctx.env, ctx.sessionFile);
    const modelsSent = modelsBack(modelRungs, tally(allProofs, allTests, contracts), unresolvedQuestion !== undefined);
    if (modelsSent !== undefined) return modelsSent;
    const open = yield* listOpen(ctx);
    const evidence = yield* step(() => progress.operations.run(
      { method: "receipt", unit: "", target: "receipt" }, () => Promise.all(changed.map((unit) =>
        unitEvidence(unit, proofs.get(unit.folder) ?? [], rungs.get(unit.folder), measured.get(unit.folder), modelRungs.get(unit.folder)))),
      () => "done"));
    const settledAt = new Date().toISOString();
    const only = workspace ? undefined : evidence[0];
    const receipt: Receipt = only !== undefined ? { version: 2, ...run, ...only, ...open, settledAt, ...judgedContext() }
      : { version: 2, repository: true, ...run, ...noEvidence, ...open, settledAt,
        ...judgedContext(), units: [
        ...evidence.map((unit, k) => ({ ...unit, folder: changed[k]?.folder ?? "" })),
        ...plain.map(({ folder }) => ({ folder, repository: false, base: null, ...noEvidence,
          reason: refused.get(folder) ?? "Git could not read it, so Tesota cannot tell what changed" }))]
        .sort((a, b) => a.folder < b.folder ? -1 : 1) };
    progress.publish({ step: "settled", receipt });
    const graphs = [...modelRungs].flatMap(([folder, rung]) => rung.models.map((model) => ({
      subject: inUnit(folder, model.path), ...model.capture === undefined ? {} : { capture: model.capture } })));
    return { entries: [receiptGraphEntry(ctx.mode, receipt, graphs)] };
  });
  return progress;
}

/**
 * What the gate measures a request against: the units of the folder Pi runs
 * in; each repository's commit `HEAD` named then, and for each folder in no
 * repository, Tesota's snapshot of it then (`takeSnapshot`), with the files
 * it left out for their size, or why there is none.
 */
interface Start {
  readonly units: readonly Unit[];
  readonly bases: ReadonlyMap<string, string | null>;
  /** Each repository's ref tips at admission (`refTips`); absent when they could not be recorded. */
  readonly refs: ReadonlyMap<string, readonly string[]>;
  readonly tooLarge: ReadonlyMap<string, readonly string[]>;
  readonly refused: ReadonlyMap<string, string>;
}

/**
 * A request as the engine's ledger records it (#439), before any tool ran:
 * its text and ordered inputs, when it started, and each unit's base, a
 * repository's commit, a snapshot, or why there is neither.
 */
export interface RecordedRequest {
  readonly run?: number;
  readonly text: string;
  readonly at: string;
  readonly inputs: readonly RequestInput[];
  /** The subagents the run started and how each ended (#525). */
  readonly children?: readonly ReceiptChild[];
  /** The calls Tesota's floor refused in the run (#622). */
  readonly refusals?: readonly FloorRefusal[];
  readonly base: { readonly units: readonly RecordedUnit[] };
  /** The earlier request this one continues (#651), and what the gate saved as it ended on its question (`savedStart`). */
  readonly continues?: { readonly run: number; readonly start?: unknown };
  /** Earlier requests since the last non-stopped receipt (#627), oldest first, judged with it. */
  readonly unverifiedRequests?: readonly (Pick<RecordedRequest, "text" | "inputs"> & { readonly run: number })[];
}

/** Each whole request in the verification chain, with its ordered operator text. */
function judgedRequests(request: RecordedRequest, run: number): RequestJudgment["requests"] {
  return [...request.unverifiedRequests ?? [], { ...request, run: request.run ?? run }]
    .map((item) => ({ run: item.run, text: operatorText(item) }));
}

/** What the operator asked in a recorded request: its text, then its amendments and answers in order, none an extension's. */
function operatorText(request: Pick<RecordedRequest, "text" | "inputs">): string[] {
  return [request.text, ...request.inputs.flatMap((input) => input.kind === "clarification"
    ? [clarificationText(input.clarification)] : input.origin === "extension" ? [] : [input.text])];
}

type RecordedUnit =
  | { readonly folder: string; readonly kind: "commit"; readonly commit: string | null; readonly refs?: readonly string[] }
  | { readonly folder: string; readonly kind: "snapshot"; readonly commit: string; readonly tooLarge: readonly string[] }
  | { readonly folder: string; readonly kind: "refused"; readonly reason: string };

/**
 * The `custom` entry the gate records as a run ends on an unresolved
 * question (#651): the start fingerprints it measured the request from, by
 * folder, which the run that continues the request restores (`restoredStart`).
 */
const requestStartType = "tesota-request-start";

function savedStart(prints: ReadonlyMap<string, Fingerprint>): EntryDraft {
  return { type: "custom", customType: requestStartType, data: { fingerprints: [...prints].map(([folder, print]) =>
    [folder, print.status === "known" ? { ...print, blobs: [...print.blobs] } : print]) } };
}

const isText = (value: unknown): value is string => typeof value === "string";

/** One saved fingerprint read back, or none when it is not one. */
function savedFingerprint(value: unknown): Fingerprint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const print = value as Record<string, unknown>;
  if (print["status"] === "unknown") return isText(print["reason"]) ? { status: "unknown", reason: print["reason"] } : undefined;
  const { head, branch, blobs, unmeasured } = print;
  if (print["status"] !== "known" || !(head === null || isText(head)) || !isText(branch) || !Array.isArray(blobs) || !Array.isArray(unmeasured)) return undefined;
  const pairs = blobs.filter((pair): pair is [string, string | null] => Array.isArray(pair) && pair.length === 2 && isText(pair[0])
    && (pair[1] === null || isText(pair[1])));
  const paths = unmeasured.filter((item): item is UnmeasuredPath => typeof item === "object" && item !== null
    && isText((item as Record<string, unknown>)["path"]) && isText((item as Record<string, unknown>)["reason"]));
  return pairs.length !== blobs.length || paths.length !== unmeasured.length ? undefined
    : { status: "known", head, branch, blobs: new Map(pairs), unmeasured: paths };
}

/** The start fingerprints a request that ended on its question saved (`savedStart`); none when nothing was saved, or what was is not that. */
function restoredStart(data: unknown): ReadonlyMap<string, Fingerprint> | undefined {
  const saved = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["fingerprints"] : undefined;
  if (!Array.isArray(saved)) return undefined;
  const prints = saved.flatMap((pair): [string, Fingerprint][] => {
    const print = Array.isArray(pair) && pair.length === 2 && isText(pair[0]) ? savedFingerprint(pair[1]) : undefined;
    return print === undefined ? [] : [[pair[0] as string, print]];
  });
  return prints.length === saved.length ? new Map(prints) : undefined;
}

/** The start `begin` would have built, from the bases the ledger recorded; a refused unit is verified by nothing, with its reason. */
function recordedStart(base: RecordedRequest["base"]): Start {
  const bases = new Map<string, string | null>();
  const refs = new Map<string, readonly string[]>();
  const tooLarge = new Map<string, readonly string[]>();
  const refused = new Map<string, string>();
  for (const unit of base.units) {
    if (unit.kind === "refused") refused.set(unit.folder, unit.reason);
    else bases.set(unit.folder, unit.commit);
    if (unit.kind === "commit" && unit.refs !== undefined) refs.set(unit.folder, unit.refs);
    if (unit.kind === "snapshot") tooLarge.set(unit.folder, unit.tooLarge);
  }
  return { units: base.units.map(({ folder, kind }) => ({ folder, repository: kind === "commit" })), bases, refs, tooLarge, refused };
}

/** The request's start in `cwd`; in a folder of repositories, its own files are snapshotted without the folders below. */
async function begin(cwd: string): Promise<Start> {
  const units = workspaceUnits(cwd);
  const workspace = units.some(({ folder }) => folder !== "");
  const bases = new Map<string, string | null>();
  const refs = new Map<string, readonly string[]>();
  const tooLarge = new Map<string, readonly string[]>();
  const refused = new Map<string, string>();
  for (const { folder, repository } of units) {
    if (repository) {
      const commit = await headCommit(join(cwd, folder));
      bases.set(folder, commit);
      const tips = await refTips(join(cwd, folder), commit);
      if (tips !== undefined) refs.set(folder, tips);
      continue;
    }
    const snapshot = await takeSnapshot(join(cwd, folder), workspace && folder === "", host().withLockWhile);
    if ("refused" in snapshot) refused.set(folder, snapshot.refused);
    else { bases.set(folder, snapshot.base); tooLarge.set(folder, snapshot.tooLarge); }
  }
  return { units, bases, refs, tooLarge, refused };
}

/**
 * A unit the request changed: its folder and checkout, its base, and its
 * changes as the gate reads them; for a folder Tesota snapshotted, the files
 * the snapshot left out for their size.
 */
interface ChangedUnit {
  readonly folder: string;
  readonly root: string;
  readonly base: string | null;
  readonly snapshot?: { readonly tooLarge: readonly string[] };
  readonly changed: readonly string[];
  readonly changes: Awaited<ReturnType<typeof fileChanges>>;
  readonly weakened: Receipt["weakened"];
  readonly unreadable: boolean;
  readonly inherited: Receipt["inherited"];
  readonly unmeasured: Receipt["unmeasured"];
  readonly startState?: Receipt["startState"];
  readonly endState?: Receipt["endState"];
}

/** The paths that differ from H: those present, untracked included, and with them the deleted; nothing when Git cannot tell. */
async function pathsFromBase(root: string, base: string | null, signal?: AbortSignal): Promise<{ present: string[]; all: string[] } | undefined> {
  const present = await changedFiles(root, base, signal);
  const deleted = base === null ? [] : await gitPaths(root, diffFrom(base, "--name-only", "--diff-filter=D"), signal);
  return present === undefined || deleted === undefined ? undefined : { present, all: [...new Set([...present, ...deleted])].sort() };
}

/** The whole diff against H, including deletions, for weakening even where attribution excludes inherited paths. */
async function changesFromBase(root: string, base: string | null): Promise<{
  paths: string[]; changes: Awaited<ReturnType<typeof fileChanges>>;
} | undefined> {
  const paths = await pathsFromBase(root, base);
  return paths === undefined ? undefined : { paths: paths.all, changes: await fileChanges(root, base, paths.present) };
}

/** How long a stopped run's inventory may read Git (#599) before the receipt says it ran past its limit. */
export const STOP_INVENTORY_TIME_LIMIT_MS: number = 30_000;

/** What a stopped run left in one unit, or why it could not be read. */
type Inventory = Pick<UnitEvidence, "changed" | "lines" | "reason"> & Partial<Pick<UnitEvidence, "inherited" | "unmeasured" | "startState" | "endState">>;

/**
 * What a stopped run left in the unit at `folder` (#599), read and never
 * run: each path changed, deleted or untracked as the request's captures
 * attribute it, with its final blob and the captures' limits; `unreadable`,
 * with why, when Git cannot tell, never an empty list. `signal` stops its Git.
 */
async function leftChanged(cwd: string, folder: string, base: string | null, fingerprint: Fingerprint | undefined, startedAt: string,
  refs: readonly string[] | undefined, signal: AbortSignal): Promise<Inventory> {
  const root = join(cwd, folder);
  const captured = fingerprint === undefined ? undefined : await fingerprintedUnit(root, base, fingerprint, startedAt, refs, signal);
  const attribution = captured?.attribution ?? { eligible: true, changed: undefined, inherited: [], unmeasured: [] };
  const start = captured?.facts.startState;
  const end = captured?.facts.endState;
  const facts = { inherited: attribution.inherited, unmeasured: attribution.unmeasured,
    ...start === undefined ? {} : { startState: start }, ...end === undefined ? {} : { endState: end } };
  const paths = !attribution.eligible ? [] : attribution.changed ?? (await pathsFromBase(root, base, signal))?.all;
  const changed = paths === undefined ? "unreadable"
    : await recordedChanges(root, paths.filter((path) => !attribution.unmeasured.some((item) => item.path === path)), signal);
  if (changed === "unreadable") {
    return { ...facts, changed, lines: "unreadable",
      reason: end?.status === "unknown" ? end.reason : "Git could not read what changed when the run stopped" };
  }
  return { ...facts, changed, lines: await checks().changeLines(root, base, changed.map(({ path }) => path), signal) };
}

/** What a stopped run left (#599): the one unit's inventory, or each unit of a folder of repositories that changed or could not be read. */
async function stoppedInventory(cwd: string, begun: Start | undefined, initial: ReadonlyMap<string, Fingerprint> | undefined, at: string,
  signal: AbortSignal): Promise<Inventory | Pick<Receipt, "units" | "snapshot" | "tooLarge">> {
  const units = begun?.units ?? [];
  const left = new Map(await Promise.all(units.filter(({ folder }) => begun?.bases.has(folder) === true)
    .map(async ({ folder }) => [folder, await leftChanged(cwd, folder, begun?.bases.get(folder) ?? null, initial?.get(folder), at,
      begun?.refs.get(folder), signal)] as const)));
  // A folder Tesota snapshotted says so, with the files the snapshot left out for their size, which no inventory of it can list.
  const read = (folder: string, repository: boolean): Inventory & Pick<UnitEvidence, "snapshot" | "tooLarge"> => {
    const tooLarge = begun?.tooLarge.get(folder) ?? [];
    return { ...repository || begun?.bases.has(folder) !== true ? {} : { snapshot: true as const },
      ...tooLarge.length === 0 ? {} : { tooLarge },
      ...left.get(folder) ?? { changed: "unreadable", lines: "unreadable",
        reason: begun?.refused.get(folder) ?? "Tesota recorded no base for the request, so it cannot tell what changed" } };
  };
  const only = units.length === 1 && units[0]?.folder === "" ? units[0] : undefined;
  if (!units.some(({ folder }) => folder !== "")) return read("", only?.repository ?? true);
  return { units: units.flatMap(({ folder, repository }) => {
    const found = read(folder, repository);
    return Array.isArray(found.changed) && found.changed.length === 0 && found.tooLarge === undefined ? []
      : [{ folder, repository, base: begun?.bases.get(folder) ?? null, ...noEvidence, ...found }];
  }) };
}

/** What a stop cut short, as the receipt says it: no check runs after a stop, and none runs again. */
function cutShort({ interrupted, notStarted }: ReturnType<GateOperations["unfinished"]>): string {
  return [...interrupted.length === 0 ? [] : [`interrupted: ${interrupted.join(", ")}`],
    ...notStarted.length === 0 ? [] : [`not started: ${notStarted.join(", ")}`], "no later check ran"].join("; ");
}

/** Each capture's facts and the committed paths since H; an unknown capture keeps verification against H. */
async function fingerprintedUnit(root: string, base: string | null, start: Fingerprint, startedAt: string,
  refs: readonly string[] | undefined, signal?: AbortSignal): Promise<{
  attribution: ReturnType<typeof compareFingerprints>;
  facts: Pick<ChangedUnit, "startState" | "endState">;
}> {
  let end = await captureFingerprint(root, signal);
  const committed = end.status !== "known" || end.head === null ? []
    : base === null ? await gitPaths(root, ["ls-tree", "-r", "--name-only", end.head], signal)
      : await gitPaths(root, [...diffFrom(base, "--name-only"), end.head], signal);
  if (committed === undefined) end = { status: "unknown", reason: "Git could not read the files committed since the admission base" };
  const compared = compareFingerprints(start, end, committed ?? []);
  const history = end.status === "known" && end.head !== base ? await historyFacts(root, base, start, end, startedAt, refs, signal) : undefined;
  const facts = { startState: start.status === "unknown" ? start : { status: "known" as const, head: start.head },
    endState: end.status === "unknown" ? end : { status: "known" as const, head: end.head, ...history === undefined ? {} : { history } } };
  return { attribution: { ...compared, eligible: compared.eligible || !attributionResolved(base, facts.startState, facts.endState, true) }, facts };
}

/**
 * The unit at `folder` as the request changed it from `base`, a commit or,
 * given what it left out (`tooLarge`), a snapshot; `unchanged` when it
 * changed nothing, and nothing when Git cannot read it.
 */
async function changedUnit(cwd: string, folder: string, base: string | null, tooLarge: readonly string[] | undefined,
  fingerprint: Fingerprint | undefined, startedAt: string, refs: readonly string[] | undefined):
  Promise<ChangedUnit | "unchanged" | undefined> {
  const root = join(cwd, folder);
  const captured = fingerprint === undefined ? undefined : await fingerprintedUnit(root, base, fingerprint, startedAt, refs);
  const attribution = captured?.attribution ?? { eligible: true, changed: undefined, inherited: [], unmeasured: [] };
  if (!attribution.eligible) return "unchanged";
  const whole = await changesFromBase(root, base);
  if (whole === undefined && captured === undefined) return undefined;
  const changed = (attribution.changed ?? whole?.paths ?? [])
    .filter((path) => !attribution.unmeasured.some((item) => item.path === path));
  const full = whole?.changes ?? "unreadable";
  const weakened = typeof full === "string" ? full : checks().weakenedEvidence(full);
  const changes = typeof full === "string" ? full : full.filter(({ path }) => changed.includes(path));
  return fingerprint === undefined && changed.length === 0 && Array.isArray(weakened) && weakened.length === 0 ? "unchanged"
    : { folder, root, base, changed, changes, weakened, unreadable: whole === undefined,
      inherited: attribution.inherited, unmeasured: attribution.unmeasured, ...captured?.facts,
      ...tooLarge === undefined ? {} : { snapshot: { tooLarge } } };
}

/** What `measure` found in one repository. */
interface Measured {
  readonly sources: readonly ProvedSource[];
  readonly strength: Pick<Receipt, "contracts" | "claimcheck">;
}

/** What the model rung found in one repository: each model it checked or kept, and the changed files with no header. */
interface ModelRung {
  readonly models: readonly ModelResult[];
  readonly unheaded: readonly string[];
}

/** Graph manifests link the session and evidence; receipt v2 does not acquire capture fields. */
function receiptModel(model: ModelResult): ModelResult {
  const { capture: _capture, ...receipt } = model;
  return { ...receipt, faults: model.faults.map(({ capture: _faultCapture, ...fault }) => fault) };
}

/** A repository's models for the receipt, when the rung found any. */
function modelEvidence(rung: ModelRung | undefined): Pick<UnitEvidence, "models" | "unheaded"> {
  return { ...rung === undefined || rung.models.length === 0 ? {} : { models: rung.models.map(receiptModel) },
    ...rung === undefined || rung.unheaded.length === 0 ? {} : { unheaded: rung.unheaded } };
}

/** Reconcile a check with the content being published, without retrying commands that may rewrite their own inputs. */
async function settledCheck<T extends { readonly evidence: Evidence; readonly verdict: Receipt["tests"][number]["verdict"] }>(
  root: string, check: T): Promise<T> {
  if (await currentContent(root, check.evidence)) return check;
  return { ...check, verdict: "operator", evidence: { ...check.evidence, outcome: "not_started", invalidated: "content_changed",
    output: `${check.evidence.output.trimEnd()}\n\nEvidence is stale: checked content changed before the receipt settled; current content was not checked.` } };
}

/** One repository's evidence for the receipt, in its own terms. */
async function unitEvidence(unit: ChangedUnit, proofs: Receipt["proofs"], rung: Pick<Receipt, "tests" | "exercises"> | undefined,
  measured: Measured | undefined, models: ModelRung | undefined): Promise<UnitEvidence> {
  const settledProofs = await Promise.all(proofs.map((proof) => settledCheck(unit.root, proof)));
  const tests = await Promise.all((rung?.tests ?? []).map((test) => settledCheck(unit.root, test)));
  const settledModels = models === undefined ? undefined : { ...models,
    models: await Promise.all(models.models.map((model) => settledCheck(unit.root, model))) };
  const sources = (measured?.sources ?? []).filter(({ path }) => settledProofs.some((proof) => proof.path === path && proof.verdict === "proved"));
  // A proof's `.dfy.gen` is the base `lsc regen` merges against, regenerated from the source the proof covers.
  const covered = new Set(settledProofs.filter(({ verdict }) => verdict === "proved").flatMap(({ evidence }) =>
    evidence.files.flatMap((path) => path.endsWith(".dfy") ? [path, `${path}.gen`] : [path])));
  return { repository: unit.snapshot === undefined, ...modelEvidence(settledModels),
    ...unit.snapshot === undefined ? {} : { snapshot: true, ...unit.snapshot.tooLarge.length === 0 ? {} : { tooLarge: unit.snapshot.tooLarge } },
    base: unit.base, proofs: settledProofs, ...measured?.strength,
    contracts: (measured?.strength.contracts ?? []).filter(({ path }) => sources.some((source) => source.path === path)),
    inherited: unit.inherited, unmeasured: unit.unmeasured,
    ...unit.startState === undefined ? {} : { startState: unit.startState },
    ...unit.endState === undefined ? {} : { endState: unit.endState },
    tests, exercises: rung?.exercises ?? [], weakened: unit.weakened,
    ...unprovedFiles(unit.changes, unit.changed, covered), uncovered: uncovered(sources, unit.changes, unit.weakened),
    changed: unit.unreadable ? "unreadable" : await recordedChanges(unit.root, unit.changed),
    lines: unit.unreadable ? "unreadable" : await checks().changeLines(unit.root, unit.base, unit.changed) };
}
