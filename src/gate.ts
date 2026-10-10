import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentBeforeSettleEvent, type AgentBeforeSettleEventResult, type ExtensionAPI, type ExtensionContext, type SessionEntry,
  VERSION } from "@earendil-works/pi-coding-agent";
import { type ChangeStatus, type ChangedFile, changedLines } from "./diff-lines.js";
import type { Evidence } from "./evidence.js";
import { git, gitOutput, headCommit } from "./git.js";
import { type ContractStrength, contractStrength } from "./proof-guarantees.js";
import { inFolder, owningProjects, suggestChecks } from "./projects.js";
import { uncoveredLines } from "./proof-coverage.js";
import { proofReport } from "./prove-tool.js";
import { inUnit, isReceipt, noEvidence, type Receipt, renderReceipt, type UnitEvidence } from "./receipt.js";
import { takeSnapshot } from "./snapshot.js";
import { type CommandRun, exerciseTests, runCommands } from "./test-rung.js";
import { commentLines, type FileChange, isTestPath, needsContent, weakenedEvidence } from "./verification-changes.js";
import type { Readiness } from "./verification/footer-rule.js";
import { gateVerdict, keepsWorking } from "./verification/gate-rule.js";
import { annotations, proveFile } from "./verification/lemmascript-verifier.js";
import { type Unit, workspaceUnits } from "./workspace.js";

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
 * is blank or only a comment (`commentLines`). A file whose lines Git did
 * not show, binary or with a change too large to read, may hold code.
 */
function onlyComments(change: FileChange | undefined): boolean {
  if (change === undefined) return false;
  const comments = commentLines(change);
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

  /**
   * The receipt a resumed session settled with, when no request came after
   * it: the last `tesota-receipt` entry on the branch, unless the operator
   * spoke later. Otherwise the status stays as it is.
   */
  resume(branch: readonly SessionEntry[]): void {
    const at = branch.findLastIndex((entry) => entry.type === "custom_message" && entry.customType === "tesota-receipt");
    const request = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "user");
    const entry = branch[at];
    if (at > request && entry?.type === "custom_message" && isReceipt(entry.details)) {
      this.publish({ step: "settled", receipt: entry.details });
    }
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
 * the request already running. Outside a Git repository the base is
 * Tesota's snapshot of the folder (`takeSnapshot`, #384); where it takes
 * none, a request that ran a tool that may change files ends with a receipt
 * that says why nothing was verified. In a folder of repositories that is in
 * none, each repository and each other folder the request changed goes
 * through these steps from its own base and folder, each round gathering
 * what goes back across them, and the receipt holds each one as a unit.
 */
export function registerGate(pi: ExtensionAPI): GateProgress {
  const progress = new GateProgress();
  pi.registerFlag(claimcheckModelFlag, { type: "string",
    description: "The provider/id of a second model for ClaimCheck to restate contracts with; the session's model otherwise" });
  /** What went back, by path or by contract as seen from the folder Pi runs in, and by command within each repository's folder. */
  let sentBack = new Map<string, string[]>();
  let commandsSentBack = new Map<string, Map<string, string[]>>();
  let weakSentBack = new Map<string, string[]>();
  let mayHaveChanged = false;
  /** What the operator asked during the request, for ClaimCheck to compare the contracts with. */
  let requests: string[] = [];
  /** The request's units and bases, recorded before the agent can run anything; a run no operator input started takes them as it settles. */
  let start: Promise<Start> | undefined;
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
    start = begin(ctx.cwd);
    await start;
    return undefined;
  });
  pi.on("tool_execution_start", (event) => { if (!readOnlyTools.has(event.toolName)) mayHaveChanged = true; });
  // A gate that fails midway leaves no step running in the footer.
  pi.on("agent_before_settle", async (event, ctx) => {
    try { return await settle(event, ctx); } catch (error) { progress.reset(); throw error; }
  });
  /** Outside Git nothing tells which files changed: a request that may have changed some settles saying none was verified. */
  const outsideGit = (run: Pick<Receipt, "base" | "startedAt" | "pi" | "model">, reason: string | undefined):
    AgentBeforeSettleEventResult | undefined => {
    if (!mayHaveChanged) return undefined;
    const receipt: Receipt = { version: 1, repository: false, ...run, settledAt: new Date().toISOString(), ...noEvidence,
      ...reason === undefined ? {} : { reason } };
    progress.publish({ step: "settled", receipt });
    return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
      display: true, details: receipt }] };
  };
  const failure = (proof: Evidence): string => `${proof.outcome}\n${proof.output}`;
  const sendBack = (content: string, details: SentBack): AgentBeforeSettleEventResult =>
    ({ entries: [{ type: "custom_message", customType: "tesota-gate", content, display: true, details }], continue: true });
  /** Every changed file with contracts proved, in each repository from its own folder. */
  const prove = async (units: readonly ChangedUnit[], signal: AbortSignal): Promise<Map<string, Receipt["proofs"][number][]>> => {
    const proofs = new Map<string, Receipt["proofs"][number][]>(units.map(({ folder }) => [folder, []]));
    for (const unit of units) {
      for (const path of await contractFiles(unit.root, unit.changed)) {
        progress.publish({ step: "proving", tally: tally([...proofs.values()].flat()) });
        const evidence = await proveFile(unit.root, path, signal);
        proofs.get(unit.folder)?.push({ path, evidence,
          verdict: gateVerdict(evidence.outcome, failure(evidence), sentBack.get(inUnit(unit.folder, path)) ?? []) });
      }
    }
    return proofs;
  };
  /** The proofs that go back, named from the folder Pi runs in. */
  const proofsBack = (proofs: ReadonlyMap<string, Receipt["proofs"]>): AgentBeforeSettleEventResult => {
    progress.publish({ step: "sent_back", tally: tally([...proofs.values()].flat()) });
    const back = [...proofs].flatMap(([folder, judged]) => judged.filter(({ verdict }) => verdict === "send_back")
      .map(({ path, evidence }) => ({ path: inUnit(folder, path), evidence })));
    for (const { path, evidence } of back) sentBack.set(path, [...sentBack.get(path) ?? [], failure(evidence)]);
    const proveActive = pi.getActiveTools().includes("prove");
    return sendBack(back.map(({ path, evidence }) =>
      `Tesota: ${path} does not prove yet.\n\n${proofReport(path, evidence, proveActive)}`).join("\n\n"), { round: "proofs", proofs: back });
  };
  /** The failing commands that go back, each run from its repository's folder. */
  const testsBack = (failing: readonly { folder: string; run: CommandRun }[], tallied: Tally): AgentBeforeSettleEventResult => {
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
  const measure = async (ctx: ExtensionContext, units: readonly ChangedUnit[], proofs: ReadonlyMap<string, Receipt["proofs"]>,
    tallied: Tally, signal: AbortSignal): Promise<Map<string, Measured>> => {
    const measured = new Map<string, Measured>();
    for (const unit of units) {
      const judged = proofs.get(unit.folder) ?? [];
      // A proof's `.dfy.gen` is the base `lsc regen` merges against, regenerated from the source the proof covers.
      const covered = new Set(judged.flatMap(({ evidence }) => evidence.files.flatMap((path) =>
        path.endsWith(".dfy") ? [path, `${path}.gen`] : [path])));
      const sources = await provedSources(unit.root, unit.base, judged);
      if (sources.length > 0) progress.publish({ step: "measuring", tally: tallied });
      measured.set(unit.folder, { covered, sources, strength: await contractStrength(ctx, requests, sources, signal, restateWith(pi)) });
    }
    return measured;
  };
  const settle = async (event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<AgentBeforeSettleEventResult | undefined> => {
    if (event.outcome !== "completed") return undefined;
    const { units, bases, tooLarge, refused } = await (start ??= begin(ctx.cwd));
    startedAt ??= new Date().toISOString();
    const workspace = units.some(({ folder }) => folder !== "");
    const run = { base: workspace ? null : bases.get("") ?? null, startedAt, pi: VERSION, ...sessionModel(ctx) };
    // Each repository and each folder Tesota snapshotted, measured from its base.
    const measurable = units.filter(({ folder }) => bases.has(folder));
    const read = await Promise.all(measurable.map(({ folder, repository }) =>
      changedUnit(ctx.cwd, folder, bases.get(folder) ?? null, repository ? undefined : tooLarge.get(folder) ?? [])));
    if (!workspace && read[0] === undefined) return outsideGit(run, refused.get(""));
    const changed = read.filter((unit): unit is ChangedUnit => typeof unit === "object");
    // A folder with no snapshot, or a repository Git could not read, is not verified; it is listed once it may have changed.
    const plain = workspace && mayHaveChanged ? [...units.filter(({ folder }) => !bases.has(folder)),
      ...measurable.filter((_, k) => read[k] === undefined)] : [];
    if (changed.length === 0 && plain.length === 0) { progress.reset(); return undefined; }
    const signal = ctx.signal ?? new AbortController().signal;
    const proofs = await prove(changed, signal);
    const allProofs = [...proofs.values()].flat();
    if (keepsWorking(allProofs.map(({ verdict }) => verdict))) return proofsBack(proofs);
    progress.publish({ step: "testing", tally: tally(allProofs) });
    const rungs = new Map<string, Pick<Receipt, "tests" | "exercises">>();
    for (const unit of changed) {
      rungs.set(unit.folder, await testRung(unit.root, unit.base, unit.changed, commandsSentBack.get(unit.folder) ?? new Map(), signal));
    }
    const allTests = [...rungs.values()].flatMap(({ tests }) => tests);
    const failing = [...rungs].flatMap(([folder, { tests }]) =>
      tests.filter(({ verdict }) => verdict === "send_back").map((test) => ({ folder, run: test })));
    if (failing.length > 0) return testsBack(failing, tally(allProofs, allTests));
    const measured = await measure(ctx, changed, proofs, tally(allProofs, allTests), signal);
    const contracts = [...measured].flatMap(([folder, { strength }]) =>
      strength.contracts.map((contract) => ({ ...contract, path: inUnit(folder, contract.path) })));
    const weak = sendBackWeak(contracts, weakSentBack);
    if (weak.length > 0) {
      progress.publish({ step: "sent_back", tally: tally(allProofs, allTests, contracts) });
      return sendBack(weak.map(weakContractReport).join("\n\n"), { round: "contracts", contracts: weak });
    }
    const evidence = await Promise.all(changed.map(async (unit) =>
      unitEvidence(unit, proofs.get(unit.folder) ?? [], rungs.get(unit.folder), measured.get(unit.folder))));
    const settledAt = new Date().toISOString();
    const only = workspace ? undefined : evidence[0];
    const receipt: Receipt = only !== undefined ? { version: 1, ...run, ...only, settledAt }
      : { version: 1, repository: true, ...run, ...noEvidence, settledAt, units: [
        ...evidence.map((unit, k) => ({ ...unit, folder: changed[k]?.folder ?? "" })),
        ...plain.map(({ folder }) => ({ folder, repository: false, base: null, ...noEvidence,
          reason: refused.get(folder) ?? "Git could not read it, so Tesota cannot tell what changed" }))]
        .sort((a, b) => a.folder < b.folder ? -1 : 1) };
    progress.publish({ step: "settled", receipt });
    return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
      display: true, details: receipt }] };
  };
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

/** The request's start in `cwd`; in a folder of repositories, its own files are snapshotted without the folders below. */
async function begin(cwd: string): Promise<Start> {
  const units = workspaceUnits(cwd);
  const workspace = units.some(({ folder }) => folder !== "");
  const bases = new Map<string, string | null>();
  const tooLarge = new Map<string, readonly string[]>();
  const refused = new Map<string, string>();
  for (const { folder, repository } of units) {
    if (repository) { bases.set(folder, await headCommit(join(cwd, folder))); continue; }
    const snapshot = await takeSnapshot(join(cwd, folder), workspace && folder === "");
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
}

/**
 * The unit at `folder` as the request changed it from `base`, a commit or,
 * given what it left out (`tooLarge`), a snapshot; `unchanged` when it
 * changed nothing, and nothing when Git cannot read it.
 */
async function changedUnit(cwd: string, folder: string, base: string | null, tooLarge: readonly string[] | undefined):
  Promise<ChangedUnit | "unchanged" | undefined> {
  const root = join(cwd, folder);
  const changed = await changedFiles(root, base);
  if (changed === undefined) return undefined;
  const changes = await fileChanges(root, base, changed);
  const weakened = typeof changes === "string" ? changes : weakenedEvidence(changes);
  return changed.length === 0 && Array.isArray(weakened) && weakened.length === 0 ? "unchanged"
    : { folder, root, base, changed, changes, weakened, ...tooLarge === undefined ? {} : { snapshot: { tooLarge } } };
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
    tests: rung?.tests ?? [], exercises: rung?.exercises ?? [], weakened: unit.weakened,
    ...unprovedFiles(unit.changes, unit.changed, measured?.covered ?? new Set()), uncovered: uncovered(sources, unit.changes, unit.weakened),
    changed: await recordedChanges(unit.root, unit.base, unit.changed) };
}
