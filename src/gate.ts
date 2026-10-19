import type * as Effect from "effect/Effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BranchEntry, ExtensionAPI, ExtensionContext, SettleResult } from "./contract.js";
import { type ChangeStatus, type ChangedFile, changedLines } from "./diff-lines.js";
import type { Evidence } from "./evidence.js";
import { git, gitOutput, headCommit } from "./git.js";
import { host } from "./host.js";
import { OPEN_CASES_MODEL, openCases } from "./open-cases.js";
import type { ContractStrength } from "./proof-guarantees.js";
import { inFolder, owningProjects, suggestChecks } from "./projects.js";
import { proofReport } from "./prove-tool.js";
import { entryReceipt, inUnit, isReceipt, noEvidence, type Receipt, receiptEntry, type UnitEvidence } from "./receipt.js";
import { captureFingerprint, compareFingerprints, type Fingerprint, pathBlobs } from "./request-fingerprint.js";
import { takeSnapshot } from "./snapshot.js";
import type { CommandRun } from "./test-rung.js";
import type { FileChange } from "./verification-changes.js";
import type { Readiness } from "./verification/footer-rule.js";
import { gateVerdict, keepsWorking, toolMayChangeFiles } from "./verification/gate-rule.js";
import { annotations, proofSources, proveFile } from "./verification/lemmascript-verifier.js";
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
let loaded: { checks: typeof import("./gate-checks.js"); effect: typeof Effect } | undefined;
async function loadChecks(): Promise<void> {
  loaded ??= { checks: await import("./gate-checks.js"), effect: await import("effect/Effect") };
}
function checks(): typeof import("./gate-checks.js") {
  if (loaded === undefined) throw new Error("The gate used its checks before settling loaded them.");
  return loaded.checks;
}
/** Effect's functions, loaded with the checks. */
function effect(): typeof Effect {
  if (loaded === undefined) throw new Error("The gate used Effect before settling loaded it.");
  return loaded.effect;
}

async function gitPaths(root: string, args: readonly string[]): Promise<string[] | undefined> {
  return (await git(root, [...args, "-z"]))?.split("\0").filter((path) => path !== "");
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
 * (`undefined`).
 */
export async function changedFiles(root: string, base: string | null): Promise<string[] | undefined> {
  const tracked = base === null ? await gitPaths(root, ["ls-files", "--cached"])
    : await gitPaths(root, diffFrom(base, "--name-only", "--diff-filter=d"));
  const untracked = await gitPaths(root, ["ls-files", "--others", "--exclude-standard"]);
  return tracked === undefined || untracked === undefined ? undefined : [...new Set([...tracked, ...untracked])].sort();
}

/**
 * Each file changed during the request, as the run leaves it: the blob id Git would
 * store for its content, or null once deleted; `unreadable` when Git cannot
 * tell. A pull request's commit holds the receipt's content exactly where its
 * blobs match (`changedAfter`).
 */
async function recordedChanges(root: string, changed: readonly string[]): Promise<Receipt["changed"]> {
  const prefix = await git(root, ["rev-parse", "--show-prefix"]);
  if (prefix === undefined) return "unreadable";
  const blobs = await pathBlobs(root, changed, prefix.trimEnd());
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
 * change. A command that fails goes back to the agent until its failure
 * repeats one already sent back (`testFailure`, `gateVerdict`). When every
 * command passes, each changed or added test runs over the request's base,
 * which shows whether it exercises the change.
 */
async function testRung(root: string, base: string | null, changed: readonly string[],
  sentBack: ReadonlyMap<string, readonly string[]>, signal: AbortSignal): Promise<Pick<Receipt, "tests" | "exercises">> {
  const projects = owningProjects(suggestChecks(root), changed);
  const tests = (await checks().runCommands(root, projects, changed, signal)).map((run) =>
    ({ ...run, verdict: gateVerdict(run.evidence.outcome, testFailure(run), sentBack.get(run.command) ?? []) }));
  const passed = tests.every(({ evidence }) => evidence.outcome === "passed");
  // A snapshot counts as a test for weakened evidence, but is not one a runner can run alone.
  const runnable = changed.filter((path) => checks().isTestPath(path) && !path.endsWith(".snap"));
  const present = (await Promise.all(runnable.map(async (path) => await readIfPresent(join(root, path)) === undefined ? [] : [path]))).flat();
  const exercises = passed && base !== null ? await checks().exerciseTests(root, base, present, changed, projects, signal) : [];
  return { tests, exercises };
}

/** What goes back to the agent for a failing command: the tests its reports name, then the end of its output. */
function failingReport({ command, failingTests, evidence }: CommandRun): string {
  const names = failingTests === undefined || failingTests.length === 0 ? ""
    : `These tests fail:\n${failingTests.map((name) => `  ${name}`).join("\n")}\n\n`;
  return `Tesota: \`${command}\` fails with your changes.\n\n${names}${evidence.output.trimEnd()}`;
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

function restateWith(pi: ExtensionAPI): string | undefined {
  const value = pi.getFlag(claimcheckModelFlag);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The Pi flag that names the model listing the cases a request leaves open (`openCases`), or `off`. */
const openCasesModelFlag = "open-cases-model";

/** The model that lists open cases, `OPEN_CASES_MODEL` unless the operator names another; undefined when turned off. */
function listWith(pi: ExtensionAPI): string | undefined {
  const value = pi.getFlag(openCasesModelFlag);
  if (value === "off") return undefined;
  return typeof value === "string" && value !== "" ? value : OPEN_CASES_MODEL;
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
  | { readonly round: "contracts"; readonly contracts: readonly ContractStrength[] };

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
 * contract goes back first (`sendBackWeak`). What went back lasts for the operator's request: it resets on their input, not
 * on `agent_start`, which every continuation fires too. When nothing goes back, the run settles with
 * a receipt for the operator. The first non-reader tool fingerprints each
 * repository; paths changed since then and commits since admission are the
 * request's change. Weakening and exercise keep the admission base H, so a
 * commit hides nothing; a steer or follow-up sent while the agent works belongs to
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
    description: "The provider/id of a second model for ClaimCheck to restate contracts with; the session's model otherwise" });
  pi.registerFlag(openCasesModelFlag, { type: "string",
    description: `The provider/id of the model that lists the cases a request leaves open, or off; ${OPEN_CASES_MODEL} otherwise` });
  /** What went back, by path or by contract as seen from the folder Pi runs in, and by command within each repository's folder. */
  let sentBack = new Map<string, string[]>();
  let commandsSentBack = new Map<string, Map<string, string[]>>();
  let weakSentBack = new Map<string, string[]>();
  let mayHaveChanged = false;
  let fingerprints: Promise<ReadonlyMap<string, Fingerprint>> | undefined;
  /** What the operator asked during the request, for ClaimCheck to compare the contracts with. */
  let requests: string[] = [];
  /** The request's units and bases, recorded before the agent can run anything; a run no operator input started takes them as it settles. */
  let start: Promise<Start> | undefined;
  let startedAt: string | undefined;
  pi.on("input", async (event, ctx) => {
    if (event.streamingBehavior !== undefined) {
      if (event.source !== "extension") requests.push(event.text);
      return undefined;
    }
    sentBack = new Map();
    commandsSentBack = new Map();
    weakSentBack = new Map();
    mayHaveChanged = false;
    fingerprints = undefined;
    start = undefined;
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
    if (!toolMayChangeFiles(event.toolName)) return;
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
    const request = recorded?.();
    if (request !== undefined) {
      requests = [request.text, ...request.amendments.flatMap(({ origin, text }) => origin === "extension" ? [] : [text])];
      startedAt = request.at;
      start = Promise.resolve(recordedStart(request.base));
    }
    if (event.outcome !== "completed") {
      const reason = "reason" in event && typeof event.reason === "string" ? event.reason : undefined;
      return stopped(ctx, reason ?? (event.outcome === "aborted" ? "the operator stopped the run before Tesota verified it"
        : "the run failed before Tesota verified it"));
    }
    // Verification is an Effect the operator's stop interrupts (#408): no later step starts, and the receipt says it stopped.
    try {
      return await effect().runPromise(settle(ctx), ctx.signal === undefined ? {} : { signal: ctx.signal });
    } catch (error) {
      if (ctx.signal?.aborted === true) return stopped(ctx, "the operator stopped the run while Tesota verified it");
      progress.reset();
      throw error;
    }
  });
  /** A run that ended before verification finished: after a tool that may change files, a receipt that verified nothing, and why. */
  const stopped = async (ctx: ExtensionContext, reason: string): Promise<SettleResult | undefined> => {
    if (!mayHaveChanged) {
      if (progress.status.step === "waiting" || "startedAt" in progress.status) progress.reset();
      return undefined;
    }
    const begun = await start;
    const workspace = begun?.units.some(({ folder }) => folder !== "") ?? false;
    const receipt: Receipt = { version: 1,
      repository: begun?.units.some(({ folder, repository }) => repository && begun.bases.has(folder)) ?? false,
      base: workspace ? null : begun?.bases.get("") ?? null, startedAt: startedAt ?? new Date().toISOString(),
      settledAt: new Date().toISOString(), engine: host().version, ...sessionModel(ctx), ...noEvidence, stopped: reason };
    progress.publish({ step: "settled", receipt });
    return { entries: [receiptEntry(ctx.mode, receipt)] };
  };
  /** Outside Git nothing tells which files changed: a request that may have changed some settles saying none was verified. */
  const outsideGit = (ctx: ExtensionContext, run: Pick<Receipt, "base" | "startedAt" | "engine" | "model">,
    reason: string | undefined): SettleResult | undefined => {
    if (!mayHaveChanged) return undefined;
    const receipt: Receipt = { version: 1, repository: false, ...run, settledAt: new Date().toISOString(), ...noEvidence,
      ...reason === undefined ? {} : { reason } };
    progress.publish({ step: "settled", receipt });
    return { entries: [receiptEntry(ctx.mode, receipt)] };
  };
  /** The cases the request leaves open, for the receipt; nothing when the operator turned the list off. */
  const listOpen = (ctx: ExtensionContext): Effect.Effect<Pick<Receipt, "openCases">> => {
    const lister = listWith(pi);
    return lister === undefined ? effect().succeed({})
      : effect().map(step((signal) => openCases(ctx, requests, lister, signal)), (listed) => ({ openCases: listed }));
  };
  const failure = (proof: Evidence): string => `${proof.outcome}\n${proof.output}`;
  const sendBack = (content: string, details: SentBack): SettleResult =>
    ({ entries: [{ type: "custom_message", customType: "tesota-gate", content, display: true, details }], continue: true });
  /** Every changed file with contracts proved, in each repository from its own folder. */
  const prove = (units: readonly ChangedUnit[]): Effect.Effect<Map<string, Receipt["proofs"][number][]>> => effect().gen(function* () {
    const proofs = new Map<string, Receipt["proofs"][number][]>(units.map(({ folder }) => [folder, []]));
    for (const unit of units) {
      for (const path of yield* step((signal) => contractFiles(unit.root, unit.changed, signal))) {
        progress.publish({ step: "proving", path: inUnit(unit.folder, path), startedAt: performance.now(),
          tally: tally([...proofs.values()].flat()) });
        const evidence = yield* step((signal) => proveFile(unit.root, path, signal));
        proofs.get(unit.folder)?.push({ path, evidence,
          verdict: gateVerdict(evidence.outcome, failure(evidence), sentBack.get(inUnit(unit.folder, path)) ?? []) });
      }
    }
    return proofs;
  });
  /** The proofs that go back, named from the folder Pi runs in. */
  const proofsBack = (proofs: ReadonlyMap<string, Receipt["proofs"]>): SettleResult => {
    progress.publish({ step: "sent_back", tally: tally([...proofs.values()].flat()) });
    const back = [...proofs].flatMap(([folder, judged]) => judged.filter(({ verdict }) => verdict === "send_back")
      .map(({ path, evidence }) => ({ path: inUnit(folder, path), evidence })));
    for (const { path, evidence } of back) sentBack.set(path, [...sentBack.get(path) ?? [], failure(evidence)]);
    const proveActive = pi.getActiveTools().includes("prove");
    return sendBack(back.map(({ path, evidence }) =>
      `Tesota: ${path} does not prove yet.\n\n${proofReport(path, evidence, proveActive)}`).join("\n\n"), { round: "proofs", proofs: back });
  };
  /** The failing commands that go back, each run from its repository's folder. */
  const testsBack = (failing: readonly { folder: string; run: CommandRun }[], tallied: Tally): SettleResult => {
    progress.publish({ step: "sent_back", tally: tallied });
    for (const { folder, run } of failing) {
      const sent = commandsSentBack.get(folder) ?? new Map<string, string[]>();
      sent.set(run.command, [...sent.get(run.command) ?? [], testFailure(run)]);
      commandsSentBack.set(folder, sent);
    }
    const shown = failing.map(({ folder, run: { command, evidence, failingTests } }): CommandRun =>
      ({ command: inFolder(folder, command), evidence, ...failingTests === undefined ? {} : { failingTests } }));
    return sendBack(shown.map(failingReport).join("\n\n"), { round: "tests", commands: shown });
  };
  /** The strength of each repository's contracts that proved, and what its proofs covered. */
  const measure = (ctx: ExtensionContext, units: readonly ChangedUnit[], proofs: ReadonlyMap<string, Receipt["proofs"]>,
    tallied: Tally): Effect.Effect<Map<string, Measured>> => effect().gen(function* () {
    const measured = new Map<string, Measured>();
    for (const unit of units) {
      const judged = proofs.get(unit.folder) ?? [];
      // A proof's `.dfy.gen` is the base `lsc regen` merges against, regenerated from the source the proof covers.
      const covered = new Set(judged.flatMap(({ evidence }) => evidence.files.flatMap((path) =>
        path.endsWith(".dfy") ? [path, `${path}.gen`] : [path])));
      const sources = yield* step(() => provedSources(unit.root, unit.base, judged));
      if (sources.length > 0) progress.publish({ step: "measuring", startedAt: performance.now(), tally: tallied });
      const strength = yield* step((signal) => checks().contractStrength(ctx, requests, sources, signal, restateWith(pi)));
      measured.set(unit.folder, { covered, sources, strength });
    }
    return measured;
  });
  /** Verification once the run completed: each step is where the operator's stop takes effect. */
  const settle = (ctx: ExtensionContext): Effect.Effect<SettleResult | undefined> => effect().gen(function* () {
    const { units, bases, tooLarge, refused } = yield* step(() => start ??= begin(ctx.cwd));
    startedAt ??= new Date().toISOString();
    const workspace = units.some(({ folder }) => folder !== "");
    const run = { base: workspace ? null : bases.get("") ?? null, startedAt, engine: host().version, ...sessionModel(ctx) };
    // Each repository and each folder Tesota snapshotted, measured from its base.
    const measurable = units.filter(({ folder }) => bases.has(folder));
    const initial = yield* step(async () => fingerprints);
    const read = yield* step(() => Promise.all(measurable.map(({ folder, repository }) =>
      changedUnit(ctx.cwd, folder, bases.get(folder) ?? null, repository ? undefined : tooLarge.get(folder) ?? [], initial?.get(folder)))));
    if (!workspace && read[0] === undefined) return outsideGit(ctx, run, refused.get(""));
    const changed = read.filter((unit): unit is ChangedUnit => typeof unit === "object");
    // A folder with no snapshot, or a repository Git could not read, is not verified; it is listed once it may have changed.
    const plain = workspace && mayHaveChanged ? [...units.filter(({ folder }) => !bases.has(folder)),
      ...measurable.filter((_, k) => read[k] === undefined)] : [];
    if (changed.length === 0 && plain.length === 0) { progress.reset(); return undefined; }
    const proofs = yield* prove(changed);
    const allProofs = [...proofs.values()].flat();
    if (keepsWorking(allProofs.map(({ verdict }) => verdict))) return proofsBack(proofs);
    progress.publish({ step: "testing", startedAt: performance.now(), tally: tally(allProofs) });
    const rungs = new Map<string, Pick<Receipt, "tests" | "exercises">>();
    for (const unit of changed) {
      rungs.set(unit.folder, yield* step((signal) =>
        testRung(unit.root, unit.base, unit.changed, commandsSentBack.get(unit.folder) ?? new Map(), signal)));
    }
    const allTests = [...rungs.values()].flatMap(({ tests }) => tests);
    const failing = [...rungs].flatMap(([folder, { tests }]) =>
      tests.filter(({ verdict }) => verdict === "send_back").map((test) => ({ folder, run: test })));
    if (failing.length > 0) return testsBack(failing, tally(allProofs, allTests));
    const measured = yield* measure(ctx, changed, proofs, tally(allProofs, allTests));
    const contracts = [...measured].flatMap(([folder, { strength }]) =>
      strength.contracts.map((contract) => ({ ...contract, path: inUnit(folder, contract.path) })));
    const weak = sendBackWeak(contracts, weakSentBack);
    if (weak.length > 0) {
      progress.publish({ step: "sent_back", tally: tally(allProofs, allTests, contracts) });
      return sendBack(weak.map(weakContractReport).join("\n\n"), { round: "contracts", contracts: weak });
    }
    const [evidence, open] = yield* effect().all([step(() => Promise.all(changed.map((unit) =>
      unitEvidence(unit, proofs.get(unit.folder) ?? [], rungs.get(unit.folder), measured.get(unit.folder))))), listOpen(ctx)],
      { concurrency: "unbounded" });
    const settledAt = new Date().toISOString();
    const only = workspace ? undefined : evidence[0];
    const receipt: Receipt = only !== undefined ? { version: 1, ...run, ...only, ...open, settledAt }
      : { version: 1, repository: true, ...run, ...noEvidence, ...open, settledAt, units: [
        ...evidence.map((unit, k) => ({ ...unit, folder: changed[k]?.folder ?? "" })),
        ...plain.map(({ folder }) => ({ folder, repository: false, base: null, ...noEvidence,
          reason: refused.get(folder) ?? "Git could not read it, so Tesota cannot tell what changed" }))]
        .sort((a, b) => a.folder < b.folder ? -1 : 1) };
    progress.publish({ step: "settled", receipt });
    return { entries: [receiptEntry(ctx.mode, receipt)] };
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
  readonly tooLarge: ReadonlyMap<string, readonly string[]>;
  readonly refused: ReadonlyMap<string, string>;
}

/**
 * A request as the engine's ledger records it (#439), before any tool ran:
 * its text and amendments, when it started, and each unit's base, a
 * repository's commit, a snapshot, or why there is neither.
 */
export interface RecordedRequest {
  readonly text: string;
  readonly at: string;
  readonly amendments: readonly { readonly origin: string; readonly text: string }[];
  readonly base: { readonly units: readonly RecordedUnit[] };
}

type RecordedUnit =
  | { readonly folder: string; readonly kind: "commit"; readonly commit: string | null }
  | { readonly folder: string; readonly kind: "snapshot"; readonly commit: string; readonly tooLarge: readonly string[] }
  | { readonly folder: string; readonly kind: "refused"; readonly reason: string };

/** The start `begin` would have built, from the bases the ledger recorded; a refused unit is verified by nothing, with its reason. */
function recordedStart(base: RecordedRequest["base"]): Start {
  const bases = new Map<string, string | null>();
  const tooLarge = new Map<string, readonly string[]>();
  const refused = new Map<string, string>();
  for (const unit of base.units) {
    if (unit.kind === "refused") refused.set(unit.folder, unit.reason);
    else bases.set(unit.folder, unit.commit);
    if (unit.kind === "snapshot") tooLarge.set(unit.folder, unit.tooLarge);
  }
  return { units: base.units.map(({ folder, kind }) => ({ folder, repository: kind === "commit" })), bases, tooLarge, refused };
}

/** The request's start in `cwd`; in a folder of repositories, its own files are snapshotted without the folders below. */
async function begin(cwd: string): Promise<Start> {
  const units = workspaceUnits(cwd);
  const workspace = units.some(({ folder }) => folder !== "");
  const bases = new Map<string, string | null>();
  const tooLarge = new Map<string, readonly string[]>();
  const refused = new Map<string, string>();
  for (const { folder, repository } of units) {
    if (repository) { bases.set(folder, await headCommit(join(cwd, folder))); continue; }
    const snapshot = await takeSnapshot(join(cwd, folder), workspace && folder === "", host().withLockWhile);
    if ("refused" in snapshot) refused.set(folder, snapshot.refused);
    else { bases.set(folder, snapshot.base); tooLarge.set(folder, snapshot.tooLarge); }
  }
  return { units, bases, tooLarge, refused };
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

/** The whole diff against H, including deletions, for weakening even where attribution excludes inherited paths. */
async function changesFromBase(root: string, base: string | null): Promise<{
  paths: string[]; changes: Awaited<ReturnType<typeof fileChanges>>;
} | undefined> {
  const paths = await changedFiles(root, base);
  const deleted = base === null ? [] : await gitPaths(root, diffFrom(base, "--name-only", "--diff-filter=D"));
  return paths === undefined || deleted === undefined ? undefined
    : { paths: [...new Set([...paths, ...deleted])].sort(), changes: await fileChanges(root, base, paths) };
}

/** Each capture's facts and the committed paths since H; an unknown capture keeps verification against H. */
async function fingerprintedUnit(root: string, base: string | null, start: Fingerprint): Promise<{
  attribution: ReturnType<typeof compareFingerprints>;
  facts: Pick<ChangedUnit, "startState" | "endState">;
}> {
  let end = await captureFingerprint(root);
  const committed = end.status !== "known" || end.head === null ? []
    : base === null ? await gitPaths(root, ["ls-tree", "-r", "--name-only", end.head])
      : await gitPaths(root, [...diffFrom(base, "--name-only"), end.head]);
  if (committed === undefined) end = { status: "unknown", reason: "Git could not read the files committed since the admission base" };
  return { attribution: compareFingerprints(start, end, committed ?? []),
    facts: { startState: start.status === "unknown" ? start : { status: "known", head: start.head },
      endState: end.status === "unknown" ? end : { status: "known", head: end.head } } };
}

/**
 * The unit at `folder` as the request changed it from `base`, a commit or,
 * given what it left out (`tooLarge`), a snapshot; `unchanged` when it
 * changed nothing, and nothing when Git cannot read it.
 */
async function changedUnit(cwd: string, folder: string, base: string | null, tooLarge: readonly string[] | undefined,
  fingerprint: Fingerprint | undefined):
  Promise<ChangedUnit | "unchanged" | undefined> {
  const root = join(cwd, folder);
  const captured = fingerprint === undefined ? undefined : await fingerprintedUnit(root, base, fingerprint);
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
  readonly covered: ReadonlySet<string>;
  readonly sources: readonly ProvedSource[];
  readonly strength: Pick<Receipt, "contracts" | "claimcheck">;
}

/** One repository's evidence for the receipt, in its own terms. */
async function unitEvidence(unit: ChangedUnit, proofs: Receipt["proofs"], rung: Pick<Receipt, "tests" | "exercises"> | undefined,
  measured: Measured | undefined): Promise<UnitEvidence> {
  const sources = measured?.sources ?? [];
  return { repository: unit.snapshot === undefined,
    ...unit.snapshot === undefined ? {} : { snapshot: true, ...unit.snapshot.tooLarge.length === 0 ? {} : { tooLarge: unit.snapshot.tooLarge } },
    base: unit.base, proofs, ...measured?.strength ?? { contracts: [] },
    inherited: unit.inherited, unmeasured: unit.unmeasured,
    ...unit.startState === undefined ? {} : { startState: unit.startState },
    ...unit.endState === undefined ? {} : { endState: unit.endState },
    tests: rung?.tests ?? [], exercises: rung?.exercises ?? [], weakened: unit.weakened,
    ...unprovedFiles(unit.changes, unit.changed, measured?.covered ?? new Set()), uncovered: uncovered(sources, unit.changes, unit.weakened),
    changed: unit.unreadable ? "unreadable" : await recordedChanges(unit.root, unit.changed) };
}
