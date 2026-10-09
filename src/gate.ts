import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentBeforeSettleEvent, type AgentBeforeSettleEventResult, type ExtensionAPI, type ExtensionContext, VERSION }
  from "@earendil-works/pi-coding-agent";
import { type ChangeStatus, type ChangedFile, changedLines } from "./diff-lines.js";
import type { Evidence } from "./evidence.js";
import { git, gitOutput, headCommit } from "./git.js";
import { type ContractStrength, contractStrength } from "./proof-guarantees.js";
import { owningProjects, suggestChecks } from "./projects.js";
import { uncoveredLines } from "./proof-coverage.js";
import { proofReport } from "./prove-tool.js";
import { type Receipt, renderReceipt } from "./receipt.js";
import { type CommandRun, exerciseTests, runCommands } from "./test-rung.js";
import { blankOrComment, type FileChange, isTestPath, needsContent, weakenedEvidence } from "./verification-changes.js";
import type { Readiness } from "./verification/footer-rule.js";
import { gateVerdict, keepsWorking } from "./verification/gate-rule.js";
import { annotations, proveFile } from "./verification/lemmascript-verifier.js";

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
 * Each file changed from `base`, as the run leaves it: the blob id Git would
 * store for its content, or null once deleted; `unreadable` when Git cannot
 * tell. A pull request's commit holds the receipt's content exactly where its
 * blobs match (`changedAfter`).
 */
async function recordedChanges(root: string, base: string | null, changed: readonly string[]): Promise<Receipt["changed"]> {
  const deleted = base === null ? [] : await gitPaths(root, diffFrom(base, "--name-only", "--diff-filter=D"));
  if (deleted === undefined) return "unreadable";
  const blobs: string[] = [];
  // In batches, to stay within the command line's length on Windows.
  for (let k = 0; k < changed.length; k += 200) {
    const batch = changed.slice(k, k + 200);
    const ids = (await git(root, ["hash-object", "--", ...batch]))?.trim().split(/\r?\n/u);
    if (ids?.length !== batch.length) return "unreadable";
    blobs.push(...ids);
  }
  return [...changed.map((path, k) => ({ path, blob: blobs[k] ?? null })), ...deleted.map((path) => ({ path, blob: null }))]
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
 * weakening rules need it (`needsContent`), or why the change could not be
 * read. A changed file the base lacks, untracked or before the first commit,
 * counts as added whole.
 */
async function fileChanges(root: string, base: string | null, changed: readonly string[]):
  Promise<FileChange[] | Exclude<Receipt["weakened"], readonly unknown[]>> {
  const diffed = base === null ? [] : await diffFromBase(root, base);
  if (typeof diffed === "string") return diffed;
  const inDiff = new Set(diffed.map(({ path }) => path));
  const whole = await Promise.all(changed.filter((path) => !inDiff.has(path)).map(async (path): Promise<FileChange> => {
    const content = await readIfPresent(join(root, path));
    return { path, status: "added", removed: [], content,
      added: content?.split(/\r?\n/u).map((text, k) => ({ number: k + 1, text })) ?? [] };
  }));
  const read = await Promise.all(diffed.map(async (file): Promise<FileChange> => base === null || !needsContent(file) ? file
    : { ...file, content: await readIfPresent(join(root, file.path)), baseContent: await git(root, ["show", `${base}:./${file.path}`]) }));
  return [...read, ...whole].sort((a, b) => a.path < b.path ? -1 : 1);
}

async function hasAnnotations(root: string, path: string): Promise<boolean> {
  try { return annotations(await readFile(join(root, path), "utf8")).length > 0; } catch { return false; }
}

/**
 * The changed TypeScript files with `//@` contracts, and those whose `.dfy`
 * proof changed, since a proof's hand-written lines are part of what it proves.
 */
async function contractFiles(root: string, changed: readonly string[]): Promise<string[]> {
  const sources = new Set(changed.map((path) => path.replace(/\.dfy(\.gen)?$/u, ".ts")).filter((path) =>
    path.endsWith(".ts") && !path.endsWith(".d.ts")));
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
  const tests = (await runCommands(root, projects, changed, signal)).map((run) =>
    ({ ...run, verdict: gateVerdict(run.evidence.outcome, testFailure(run), sentBack.get(run.command) ?? []) }));
  const passed = tests.every(({ evidence }) => evidence.outcome === "passed");
  // A snapshot counts as a test for weakened evidence, but is not one a runner can run alone.
  const runnable = changed.filter((path) => isTestPath(path) && !path.endsWith(".snap"));
  const exercises = passed && base !== null ? await exerciseTests(root, base, runnable, changed, projects, signal) : [];
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
  return Promise.all(proofs.filter(({ verdict }) => verdict === "proved").map(async ({ path }) => ({ path,
    source: await readIfPresent(join(root, path)) ?? "",
    baseSource: base === null ? undefined : await git(root, ["show", `${base}:./${path}`]) })));
}

type ProvedSource = { readonly path: string; readonly source: string; readonly baseSource: string | undefined };

/** The changed lines of each TypeScript file that proved that no contract's proof covers (`uncoveredLines`). */
function uncovered(sources: readonly ProvedSource[], changes: Awaited<ReturnType<typeof fileChanges>>,
  weakened: Receipt["weakened"]): Receipt["uncovered"] {
  if (typeof changes === "string" || typeof weakened === "string") return [];
  const byPath = new Map(changes.map((change) => [change.path, change]));
  return sources.flatMap(({ path, source, baseSource }) => {
    const change = byPath.get(path);
    return change === undefined || !path.endsWith(".ts") ? [] : [uncoveredLines(change, source, baseSource, weakened)];
  });
}

/**
 * Whether a file's change holds no code: it added or removed lines, and each
 * is blank or only a comment (`blankOrComment`). A file whose lines Git did
 * not show, binary or with a change too large to read, may hold code.
 */
function onlyComments(change: FileChange | undefined): boolean {
  if (change === undefined) return false;
  const lines = [...change.added, ...change.removed];
  return lines.length > 0 && lines.every(({ text }) => blankOrComment(change.path, text));
}

/**
 * The changed files no proof covers (`covered`), other than test files and
 * files whose change holds no code (`onlyComments`), and whether no file's
 * change held any.
 */
function unprovedFiles(changes: Awaited<ReturnType<typeof fileChanges>>, changed: readonly string[],
  covered: ReadonlySet<string>): Pick<Receipt, "unverified" | "commentsOnly"> {
  const read = typeof changes === "string" ? [] : changes;
  const unverified = changed.filter((path) => !covered.has(path) && !isTestPath(path) &&
    !onlyComments(read.find((file) => file.path === path)));
  return read.length > 0 && read.every(onlyComments) ? { unverified, commentsOnly: true } : { unverified };
}

/** The Pi flag that names ClaimCheck's second model (`claimCheck`). */
const claimcheckModelFlag = "claimcheck-model";

function restateWith(pi: ExtensionAPI): string | undefined {
  const value = pi.getFlag(claimcheckModelFlag);
  return typeof value === "string" && value !== "" ? value : undefined;
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
 * What goes back for the weak contracts, each until its surviving changes
 * repeat ones already sent back (`gateVerdict`), recorded in `sentBack`;
 * undefined when none goes back.
 */
function sendBackWeak(strength: readonly ContractStrength[], sentBack: Map<string, string[]>): string | undefined {
  const key = ({ path, name }: ContractStrength): string => `${path}#${name}`;
  const weak = strength.filter((item) => item.mutation.survived.length > 0
    && gateVerdict("failed", weakFailure(item), sentBack.get(key(item)) ?? []) === "send_back");
  for (const item of weak) sentBack.set(key(item), [...sentBack.get(key(item)) ?? [], weakFailure(item)]);
  return weak.length === 0 ? undefined : weak.map(weakContractReport).join("\n\n");
}

/** The session's model as the receipt records it, when one is set. */
function sessionModel(ctx: Pick<ExtensionContext, "model">): Pick<Receipt, "model"> {
  return ctx.model === undefined ? {} : { model: `${ctx.model.provider}/${ctx.model.id}` };
}

/** Built-in tools that only read, and `prove`, whose changes are the proof's own; any other tool may change files. */
const readOnlyTools = new Set(["read", "grep", "find", "ls", "prove"]);

/** What the gate's current round found so far: proofs, then the commands, then weak contracts. */
export interface Tally {
  readonly proved: number;
  readonly notProved: number;
  readonly tests?: "pass" | "fail";
  readonly weak?: number;
}

/**
 * What the gate is doing, for the footer. Between requests it is ready with
 * what the project lets it verify. While a run settles it is proving,
 * testing or measuring contracts; it has `sent_back` failures while the
 * agent answers them, and is `settled` once the run ends with a receipt.
 */
export type GateStatus =
  | { readonly step: "ready"; readonly readiness: Readiness }
  | { readonly step: "proving" | "testing" | "measuring" | "sent_back"; readonly tally: Tally }
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

  /** Back to ready, as on the operator's next request. */
  reset(): void { this.publish({ step: "ready", readiness: this.#readiness }); }

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
 * a receipt for the operator. Changes are measured against the commit `HEAD`
 * named when the operator's request started, so a commit the agent makes
 * hides nothing; a steer or follow-up sent while the agent works belongs to
 * the request already running. Outside a Git repository it cannot tell what
 * changed, so a request that ran a tool that may change files ends with a
 * receipt that says so.
 */
export function registerGate(pi: ExtensionAPI): GateProgress {
  const progress = new GateProgress();
  pi.registerFlag(claimcheckModelFlag, { type: "string",
    description: "The provider/id of a second model for ClaimCheck to restate contracts with; the session's model otherwise" });
  let sentBack = new Map<string, string[]>();
  let commandsSentBack = new Map<string, string[]>();
  let weakSentBack = new Map<string, string[]>();
  let mayHaveChanged = false;
  /** What the operator asked during the request, for ClaimCheck to compare the contracts with. */
  let requests: string[] = [];
  /** The request's base, recorded before the agent can run anything; a run no operator input started takes `HEAD` as it settles. */
  let base: Promise<string | null> | undefined;
  let startedAt: string | undefined;
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return undefined;
    sentBack = new Map();
    commandsSentBack = new Map();
    weakSentBack = new Map();
    mayHaveChanged = false;
    progress.reset();
    if (event.streamingBehavior !== undefined) { requests.push(event.text); return undefined; }
    requests = [event.text];
    startedAt = new Date().toISOString();
    base = headCommit(ctx.cwd);
    await base;
    return undefined;
  });
  pi.on("tool_execution_start", (event) => { if (!readOnlyTools.has(event.toolName)) mayHaveChanged = true; });
  // A gate that fails midway leaves no step running in the footer.
  pi.on("agent_before_settle", async (event, ctx) => {
    try { return await settle(event, ctx); } catch (error) { progress.reset(); throw error; }
  });
  /** Outside Git nothing tells which files changed: a request that may have changed some settles saying none was verified. */
  const outsideGit = (run: Pick<Receipt, "base" | "startedAt" | "pi" | "model">): AgentBeforeSettleEventResult | undefined => {
    if (!mayHaveChanged) return undefined;
    const receipt: Receipt = { version: 1, repository: false, ...run, settledAt: new Date().toISOString(), proofs: [],
      contracts: [], tests: [], exercises: [], weakened: [], unverified: [], uncovered: [], changed: [] };
    progress.publish({ step: "settled", receipt });
    return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
      display: true, details: receipt }] };
  };
  const settle = async (event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined> => {
    if (event.outcome !== "completed") return undefined;
    const from = await (base ??= headCommit(ctx.cwd));
    startedAt ??= new Date().toISOString();
    const run = { base: from, startedAt, pi: VERSION, ...sessionModel(ctx) };
    const changed = await changedFiles(ctx.cwd, from);
    if (changed === undefined) return outsideGit(run);
    const changes = await fileChanges(ctx.cwd, from, changed);
    const weakened = typeof changes === "string" ? changes : weakenedEvidence(changes);
    if (changed.length === 0 && Array.isArray(weakened) && weakened.length === 0) { progress.reset(); return undefined; }
    const signal = ctx.signal ?? new AbortController().signal;
    const failure = (proof: Evidence): string => `${proof.outcome}\n${proof.output}`;
    const judged: Receipt["proofs"][number][] = [];
    for (const path of await contractFiles(ctx.cwd, changed)) {
      progress.publish({ step: "proving", tally: tally(judged) });
      const evidence = await proveFile(ctx.cwd, path, signal);
      judged.push({ path, verdict: gateVerdict(evidence.outcome, failure(evidence), sentBack.get(path) ?? []), evidence });
    }
    if (keepsWorking(judged.map(({ verdict }) => verdict))) {
      progress.publish({ step: "sent_back", tally: tally(judged) });
      const back = judged.filter(({ verdict }) => verdict === "send_back");
      for (const { path, evidence } of back) sentBack.set(path, [...sentBack.get(path) ?? [], failure(evidence)]);
      const proveActive = pi.getActiveTools().includes("prove");
      const content = back.map(({ path, evidence }) =>
        `Tesota: ${path} does not prove yet.\n\n${proofReport(path, evidence, proveActive)}`).join("\n\n");
      return { entries: [{ type: "custom_message", customType: "tesota-gate", content, display: true }], continue: true };
    }
    progress.publish({ step: "testing", tally: tally(judged) });
    const { tests, exercises } = await testRung(ctx.cwd, from, changed, commandsSentBack, signal);
    const failing = tests.filter(({ verdict }) => verdict === "send_back");
    if (failing.length > 0) {
      progress.publish({ step: "sent_back", tally: tally(judged, tests) });
      for (const run of failing) commandsSentBack.set(run.command, [...commandsSentBack.get(run.command) ?? [], testFailure(run)]);
      return { entries: [{ type: "custom_message", customType: "tesota-gate", content: failing.map(failingReport).join("\n\n"),
        display: true }], continue: true };
    }
    // A proof's `.dfy.gen` is the base `lsc regen` merges against, regenerated from the source the proof covers.
    const covered = new Set(judged.flatMap(({ evidence }) => evidence.files.flatMap((path) =>
      path.endsWith(".dfy") ? [path, `${path}.gen`] : [path])));
    const sources = await provedSources(ctx.cwd, from, judged);
    if (sources.length > 0) progress.publish({ step: "measuring", tally: tally(judged, tests) });
    const strength = await contractStrength(ctx, requests, sources, signal, restateWith(pi));
    const weak = sendBackWeak(strength.contracts, weakSentBack);
    if (weak !== undefined) {
      progress.publish({ step: "sent_back", tally: tally(judged, tests, strength.contracts) });
      return { entries: [{ type: "custom_message", customType: "tesota-gate", content: weak, display: true }], continue: true };
    }
    const receipt: Receipt = { version: 1, repository: true, ...run, proofs: judged, ...strength, tests, exercises, weakened,
      ...unprovedFiles(changes, changed, covered), uncovered: uncovered(sources, changes, weakened),
      changed: await recordedChanges(ctx.cwd, from, changed), settledAt: new Date().toISOString() };
    progress.publish({ step: "settled", receipt });
    return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
      display: true, details: receipt }] };
  };
  return progress;
}
