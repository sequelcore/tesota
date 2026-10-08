import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ChangeStatus, type ChangedFile, changedLines } from "./diff-lines.js";
import type { Evidence } from "./evidence.js";
import { contractStrength } from "./proof-guarantees.js";
import { owningProjects, suggestChecks } from "./projects.js";
import { proofReport } from "./prove-tool.js";
import { type Receipt, renderReceipt } from "./receipt.js";
import { type CommandRun, exerciseTests, runCommands } from "./test-rung.js";
import { type FileChange, isTestPath, needsContent, weakenedEvidence } from "./verification-changes.js";
import { gateVerdict, keepsWorking } from "./verification/gate-rule.js";
import { annotations, proveFile } from "./verification/lemmascript-verifier.js";

const outputLimit = 16 * 1024 * 1024;

/**
 * Git's output in `root`; `too_large` when it passes what the gate reads,
 * undefined when Git fails. Past the limit it closes Git's output and waits
 * for Git to exit on the broken pipe instead of killing it: on Windows the
 * `git` on PATH can be a launcher, and killing it would leave the Git it
 * started running in the project after the gate moved on.
 */
function gitOutput(root: string, args: readonly string[]): Promise<string | "too_large" | undefined> {
  return new Promise((settle) => {
    const child = spawn("git", [...args], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) child.stdout.destroy();
      else chunks.push(chunk);
    });
    child.once("error", () => { settle(undefined); });
    child.once("close", (status) => {
      settle(size > outputLimit ? "too_large" : status === 0 ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
  });
}

async function git(root: string, args: readonly string[]): Promise<string | undefined> {
  const output = await gitOutput(root, args);
  return output === "too_large" ? undefined : output;
}

async function gitPaths(root: string, args: readonly string[]): Promise<string[] | undefined> {
  return (await git(root, [...args, "-z"]))?.split("\0").filter((path) => path !== "");
}

/** `git diff` from `base`, relative to the project, as this module reads it whatever the operator's Git configuration. */
function diffFrom(base: string, ...options: string[]): string[] {
  return ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
    "--relative", "--src-prefix=a/", "--dst-prefix=b/", ...options, base];
}

/** The commit `HEAD` names in the project at `root`; null before its first commit, and outside Git. */
export async function headCommit(root: string): Promise<string | null> {
  const commit = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]))?.trim();
  return commit === undefined || commit === "" ? null : commit;
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
 * The changes from `base` that may weaken the evidence (`weakenedEvidence`),
 * or why they could not be checked. A changed file the base lacks, untracked
 * or before the first commit, counts as added whole.
 */
async function weakenings(root: string, base: string | null, changed: readonly string[]): Promise<Receipt["weakened"]> {
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
  return weakenedEvidence([...read, ...whole].sort((a, b) => a.path < b.path ? -1 : 1));
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

/**
 * How strong the contracts are that the request added or changed in the
 * files that proved (`contractStrength`), measured against their content at
 * the request's base.
 */
async function strength(ctx: ExtensionContext, base: string | null, proofs: Receipt["proofs"], requests: readonly string[],
  signal: AbortSignal, restateWith: string | undefined): Promise<Pick<Receipt, "contracts" | "claimcheck">> {
  const files = await Promise.all(proofs.filter(({ verdict }) => verdict === "proved").map(async ({ path }) => ({ path,
    source: await readIfPresent(join(ctx.cwd, path)) ?? "",
    baseSource: base === null ? undefined : await git(ctx.cwd, ["show", `${base}:./${path}`]) })));
  return contractStrength(ctx, requests, files, signal, restateWith);
}

/** The Pi flag that names ClaimCheck's second model (`claimCheck`). */
const claimcheckModelFlag = "claimcheck-model";

function restateWith(pi: ExtensionAPI): string | undefined {
  const value = pi.getFlag(claimcheckModelFlag);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Built-in tools that only read, and `prove`, whose changes are the proof's own; any other tool may change files. */
const readOnlyTools = new Set(["read", "grep", "find", "ls", "prove"]);

/**
 * The gate (#339): before a completed run settles, it proves every changed
 * file with contracts. A failed or vacuous proof goes back to the agent and
 * the run continues, until the agent repeats any failure the gate already
 * sent back for that file (`gateVerdict`). Then the test rung runs
 * (`testRung`), and once it passes, the strength of the contracts the
 * request added or changed is measured (`strength`) for the receipt. What
 * went back lasts for the operator's request: it resets on their input, not
 * on `agent_start`, which every continuation fires too. When nothing goes back, the run settles with
 * a receipt for the operator. Changes are measured against the commit `HEAD`
 * named when the operator's request started, so a commit the agent makes
 * hides nothing; a steer or follow-up sent while the agent works belongs to
 * the request already running. Outside a Git repository it cannot tell what
 * changed, so a request that ran a tool that may change files ends with a
 * receipt that says so.
 */
export function registerGate(pi: ExtensionAPI): void {
  pi.registerFlag(claimcheckModelFlag, { type: "string",
    description: "The provider/id of a second model for ClaimCheck to restate contracts with; the session's model otherwise" });
  let sentBack = new Map<string, string[]>();
  let commandsSentBack = new Map<string, string[]>();
  let mayHaveChanged = false;
  /** What the operator asked during the request, for ClaimCheck to compare the contracts with. */
  let requests: string[] = [];
  /** The request's base, recorded before the agent can run anything; a run no operator input started takes `HEAD` as it settles. */
  let base: Promise<string | null> | undefined;
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return undefined;
    sentBack = new Map();
    commandsSentBack = new Map();
    mayHaveChanged = false;
    if (event.streamingBehavior !== undefined) { requests.push(event.text); return undefined; }
    requests = [event.text];
    base = headCommit(ctx.cwd);
    await base;
    return undefined;
  });
  pi.on("tool_execution_start", (event) => { if (!readOnlyTools.has(event.toolName)) mayHaveChanged = true; });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event.outcome !== "completed") return undefined;
    const from = await (base ??= headCommit(ctx.cwd));
    const changed = await changedFiles(ctx.cwd, from);
    if (changed === undefined) {
      if (!mayHaveChanged) return undefined;
      const receipt: Receipt = { version: 0, repository: false, proofs: [], contracts: [], tests: [], exercises: [], weakened: [], unverified: [] };
      return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
        display: true, details: receipt }] };
    }
    const weakened = await weakenings(ctx.cwd, from, changed);
    if (changed.length === 0 && Array.isArray(weakened) && weakened.length === 0) return undefined;
    const signal = ctx.signal ?? new AbortController().signal;
    const failure = (proof: Evidence): string => `${proof.outcome}\n${proof.output}`;
    const judged: Receipt["proofs"][number][] = [];
    for (const path of await contractFiles(ctx.cwd, changed)) {
      const evidence = await proveFile(ctx.cwd, path, signal);
      judged.push({ path, verdict: gateVerdict(evidence.outcome, failure(evidence), sentBack.get(path) ?? []), evidence });
    }
    if (keepsWorking(judged.map(({ verdict }) => verdict))) {
      const back = judged.filter(({ verdict }) => verdict === "send_back");
      for (const { path, evidence } of back) sentBack.set(path, [...sentBack.get(path) ?? [], failure(evidence)]);
      const proveActive = pi.getActiveTools().includes("prove");
      const content = back.map(({ path, evidence }) =>
        `Tesota: ${path} does not prove yet.\n\n${proofReport(path, evidence, proveActive)}`).join("\n\n");
      return { entries: [{ type: "custom_message", customType: "tesota-gate", content, display: true }], continue: true };
    }
    const { tests, exercises } = await testRung(ctx.cwd, from, changed, commandsSentBack, signal);
    const failing = tests.filter(({ verdict }) => verdict === "send_back");
    if (failing.length > 0) {
      for (const run of failing) commandsSentBack.set(run.command, [...commandsSentBack.get(run.command) ?? [], testFailure(run)]);
      return { entries: [{ type: "custom_message", customType: "tesota-gate", content: failing.map(failingReport).join("\n\n"),
        display: true }], continue: true };
    }
    // A proof's `.dfy.gen` is the base `lsc regen` merges against, regenerated from the source the proof covers.
    const covered = new Set(judged.flatMap(({ evidence }) => evidence.files.flatMap((path) =>
      path.endsWith(".dfy") ? [path, `${path}.gen`] : [path])));
    const receipt: Receipt = { version: 0, repository: true, proofs: judged,
      ...await strength(ctx, from, judged, requests, signal, restateWith(pi)), tests, exercises, weakened,
      unverified: changed.filter((path) => !covered.has(path)) };
    return { entries: [{ type: "custom_message", customType: "tesota-receipt", content: renderReceipt(receipt),
      display: true, details: receipt }] };
  });
}
