import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { type Dirent, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync,
  realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";
import { type Evidence, contentHash } from "./evidence.js";
import { git as gitRead, gitEnvironment } from "./git.js";
import { type CheckCommand, type ProjectChecks, findProjects, inFolder, nearestWorkspaceRoot, owningProjects, packageRunner, packageTest, suggestChecks } from "./projects.js";
import { parseJson } from "./json.js";
import { runProcess } from "./process.js";
import { clearTestReports, confinedPath, failuresSeenOnBase, introducedTests, readTestResults, type TestResults } from "./test-report.js";
import { type CheckOrigin, type CheckOutcome, checkOrigin, fixedCheck, reportCoversFailures, sourceAssertion } from "./verification/check-origin-rule.js";
import { host } from "./host.js";
import { noOperations, type OperationResult, type OperationSink, type OperationSpec } from "./operations.js";
import { checkApprovalProblem, checkFolderProblem, checksFile, readDeclaredChecks } from "./project-checks.js";
import { checkoutRoot } from "./checkout-root.js";

const execFileAsync = promisify(execFile);

/** How a command run ended. */
export type CommandOutcome = Extract<CheckOutcome, "passed" | "failed" | "timed_out" | "cancelled" | "not_started">;

const defaultTimeoutMs = 15 * 60_000;

/**
 * Run one of the project's checks in the shell the engine gives for them (`HostParts.shellConfig`),
 * from `cwd`, through `runProcess`.
 */
export async function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number = defaultTimeoutMs,
  env?: Environment): Promise<{ outcome: CommandOutcome; output: string }> {
  let config: ReturnType<ReturnType<typeof host>["shellConfig"]>;
  try { config = host().shellConfig(); } catch (error) {
    return { outcome: "not_started", output: error instanceof Error ? error.message : String(error) };
  }
  if (config.commandTransport === "stdin") {
    return { outcome: "not_started", output: `${config.shell} reads commands from its input, which Tesota cannot give it.` };
  }
  const { ended, exitCode, output } = await runProcess(config.shell, [...config.args, command], cwd, signal, timeoutMs, undefined,
    env === undefined ? {} : { env: { ...process.env, ...env } });
  return { outcome: ended === "exited" ? exitCode === 0 ? "passed" : "failed" : ended, output };
}

const reportDepth = 6;
const reportEntries = 5_000;

/**
 * The JUnit XML reports a command wrote under a project's folder while it
 * ran: `.xml` files changed since `since`, relative to `root`, outside
 * dependency and dot folders, to a bounded depth and number of entries.
 */
function reportsWritten(root: string, folder: string, since: number): string[] {
  const found: string[] = [];
  const queue = [{ path: folder, depth: 0 }];
  let seen = 0;
  for (let next = queue.shift(); next !== undefined && seen < reportEntries; next = queue.shift()) {
    let entries: Dirent[];
    try { entries = readdirSync(join(root, next.path), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      const path = next.path === "" ? entry.name : `${next.path}/${entry.name}`;
      if (entry.isDirectory() && next.depth < reportDepth && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        queue.push({ path, depth: next.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".xml")) {
        try { if (statSync(join(root, path)).mtimeMs >= since) found.push(path); } catch { /* gone */ }
      }
    }
  }
  return found.sort();
}

/** One of the project's commands, run on the change, with the tests that failed when it wrote a test report. */
export interface CommandRun {
  readonly command: string;
  /** A declared invocation's immutable contract identity, distinct even when command text is repeated. */
  readonly declaration?: { readonly hash: string; readonly index: number };
  readonly evidence: Evidence;
  /** The failing tests' names, sorted, from the JUnit reports the run wrote; undefined when it wrote none. */
  readonly failingTests?: readonly string[] | undefined;
  /** Why a command failed, or why its cause is unknown when it did not finish. */
  readonly origin?: CommandOrigin;
  /** The actual comparable base execution, including an explicit not-started comparison when unavailable. */
  readonly baseline?: { readonly outcome: CommandOutcome; readonly output: string };
}

/** Whether the change, the base already, or neither run can tell, is why a command fails (`checkOrigin`), and what showed it. */
export interface CommandOrigin {
  readonly cause: CheckOrigin | "fixed";
  readonly reason: string;
}

/** The base a command's failure is compared with: its commit, or why a run there would not show the request's start. */
export type Against = { readonly base: string } | { readonly unfaithful: string };

const limits = "Shows only that the project's commands passed on these files; it says nothing about what the tests " +
  "leave unchecked.";

function read(root: string, path: string): string | undefined {
  try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; }
}

function bytes(root: string, path: string): Buffer | undefined {
  try { return readFileSync(join(root, path)); } catch { return undefined; }
}

/**
 * Run the commands of the projects that own the changed files at `root`, one
 * evidence each, bound to the changed files' content as it was when the
 * commands started. Given a base to compare `against`, each command that
 * failed runs there too, and carries why it fails (`originsOnBase`). A timed-out
 * check did not finish: its cause stays unknown and it is never rerun on the base.
 */
export async function runCommands(root: string, projects: readonly ProjectChecks[], changed: readonly string[],
  signal: AbortSignal, ops: OperationSink = noOperations, env?: Environment, against?: Against): Promise<CommandRun[]> {
  const ran = await commandRuns(root, projects, changed, signal, ops, env);
  const compared = ran.filter(({ outcome }) => outcome === "failed" || outcome === "passed");
  if (against === undefined || compared.length === 0) return ran.map(({ run }) => run);
  const comparisons = new Map((await originsOnBase(root, against, compared, changed, signal, ops, env)).map((comparison, k) => [compared[k], comparison]));
  return ran.map((each) => ({ ...each.run, ...comparisons.get(each) }));
}

/** A command's run on the change, with the owning folder and the reports it wrote. */
interface Ran {
  readonly project: ProjectChecks;
  readonly check: CheckCommand;
  readonly run: CommandRun;
  readonly outcome: CommandOutcome;
  readonly results: TestResults | undefined;
  readonly probe?: Probe;
}

async function commandRuns(root: string, projects: readonly ProjectChecks[], changed: readonly string[],
  signal: AbortSignal, ops: OperationSink, env: Environment | undefined): Promise<Ran[]> {
  const hash = contentHash(changed.map((path) => ({ path, content: read(root, path) })));
  const runs: Ran[] = [];
  const spec = (command: string): OperationSpec => ({ method: "command", unit: "", target: command });
  const planned = projects.flatMap((project) => project.commands.map((check) => ops.plan(spec(checkCommand(root, project, check)))));
  let next = 0;
  for (const project of projects) {
    const { commands } = project;
    for (const [index, check] of commands.entries()) {
      const { folder } = check;
      const command = checkCommand(root, project, check);
      const probe = check.script === undefined ? undefined
        : runnerProbe(check.script, inFolder(folder, `${check.command}${check.argumentSeparator === undefined ? "" : " --"}`), folder);
      const started = Date.now();
      // After a stop nothing is launched, so no start is published and the planned command closes as not started.
      const id = planned[next++];
      const execute = async (): Promise<BaseRun> => {
        const problem = admittedInvocationProblem(root, project, check);
        if (problem !== undefined) return { outcome: "not_started", output: problem, results: undefined };
        if (probe !== undefined) return probeRun(probe, root, signal, env, check.timeoutMs);
        return runCheck(root, project, check, signal, env);
      };
      const ran: BaseRun = signal.aborted ? { ...await runShell(command, root, signal), results: undefined }
        : await ops.run(spec(command), execute, (ran) => ran.outcome, id);
      const { outcome } = ran;
      const output = ran.output ?? "";
      const { results } = ran;
      const failingTests = results === undefined ? undefined
        : [...results.tests].filter(([, status]) => status === "failed").map(([name]) => name).sort();
      runs.push({ project, check, outcome, results, ...probe === undefined ? {} : { probe }, run: { command, failingTests,
        ...project.approval === undefined ? {} : { declaration: { hash: project.approval.hash, index } },
        ...outcome === "timed_out" ? { origin: { cause: "unknown" as const,
          reason: "the check did not finish within its time limit; it was not rerun on the base" } } : {},
        evidence: { verifier: "command",
        claim: `\`${command}\` passes with these changes.`, limits, outcome, output, durationMs: Date.now() - started, files: changed,
        contentHash: hash } } });
    }
  }
  return runs;
}

/** A package-manager invocation must still resolve to its admitted script, never a replacement written during the request. */
function admittedScriptProblem(root: string, check: CheckCommand): string | undefined {
  if (check.script === undefined) return undefined;
  const scriptName = /^(?:npm|bun|pnpm|yarn) run (check|typecheck|lint|test)$/u.exec(check.command)?.[1];
  if (scriptName === undefined) return "the admitted package invocation cannot be identified";
  if (`${packageRunner(join(root, check.folder))} ${scriptName}` !== check.command) return "the admitted package manager changed or is unavailable";
  try {
    const manifest: unknown = parseJson(readFileSync(join(root, check.folder, "package.json"), "utf8"));
    const scripts: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "scripts") : undefined;
    if (typeof scripts === "object" && scripts !== null && Reflect.get(scripts, scriptName) === check.script) return undefined;
  } catch { /* an unreadable manifest cannot retain the admitted invocation */ }
  return `the admitted package script ${scriptName} changed or is unavailable; this is not the recorded check`;
}

/** Stored selection is data, not execution authority: revalidate its concrete invocation against the current owner. */
function admittedInvocationProblem(root: string, project: ProjectChecks, check: CheckCommand): string | undefined {
  const confinement = checkFolderProblem(executionRoot(root, project), check.folder);
  if (confinement !== undefined) return confinement;
  if (project.approval === undefined && project.folder !== check.folder) return "the admitted invocation does not belong to its project";
  const { approval } = project;
  if (approval !== undefined) {
    if (approval.root !== checkoutRoot(root)) return "the admitted declaration belongs to another checkout";
    const problem = checkApprovalProblem(approval);
    if (problem !== undefined) return problem;
    const declared = readDeclaredChecks(approval.root);
    return declared.status === "read" && declared.checks.some((current) => JSON.stringify(current) === JSON.stringify(check))
      ? undefined : "the admitted invocation does not match its approved declaration";
  }
  if (check.script !== undefined) return admittedScriptProblem(root, check);
  const current = suggestChecks(root).find((selected) => selected.folder === project.folder && selected.approval === undefined);
  return current?.commands.some((selected) => JSON.stringify(selected) === JSON.stringify(check)) === true
    ? undefined : "the admitted invocation no longer matches a discovered project check";
}

/**
 * Each failing command run once more in a worktree of the base, and why it
 * fails (`commandOrigin`). Nothing is credited to the base where a run there
 * would not show the request's start: none, a start the base doesn't hold, or
 * a change to what decides the dependencies the base borrows from the checkout.
 */
async function originsOnBase(root: string, against: Against, failing: readonly Ran[], changed: readonly string[],
  signal: AbortSignal, ops: OperationSink, env: Environment | undefined): Promise<Pick<CommandRun, "origin" | "baseline">[]> {
  const unknown = (reason: string): Pick<CommandRun, "origin" | "baseline">[] => failing.map(({ outcome }) => ({
    ...outcome === "failed" ? { origin: { cause: "unknown" as const, reason } } : {},
    baseline: { outcome: "not_started", output: reason } }));
  if ("unfaithful" in against) return unknown(against.unfaithful);
  const configurationProblem = await baseConfigurationProblem(root, against.base, changed, failing.map(({ project }) => project), signal);
  if (configurationProblem !== undefined) return unknown(configurationProblem);
  const declarationProblem = await declarationsAtBase(against.base, failing.map(({ project }) => project));
  if (declarationProblem !== undefined) return unknown(declarationProblem);
  try {
    return await atBase(root, against.base, async (project) => {
      const found: Pick<CommandRun, "origin" | "baseline">[] = [];
      for (const { project: selected, check, run, outcome, results, probe } of failing) {
        const base = await ops.run({ method: "base_command", unit: "", target: run.command },
          () => probe === undefined ? runCheck(project, selected, check, signal, env) : probeRun(probe, project, signal, env, check.timeoutMs),
          (ended) => ended.outcome);
        const origin = commandOrigin(outcome, results, base);
        found.push({ ...origin === undefined ? {} : { origin }, baseline: { outcome: base.outcome, output: base.output ?? "" } });
      }
      return found;
    });
  } catch (error) {
    const why = error instanceof Error ? error.message.trim().split("\n").at(-1) ?? "" : String(error);
    return unknown(`the base could not be checked out: ${why}`);
  }
}

/**
 * Why a command that failed or timed out on the change does (`checkOrigin`):
 * the change, when the base passes or some test fails only with it; the base
 * already, only when the reports show each failing test failing there too;
 * otherwise unknown, with what kept it so.
 */
function commandOrigin(outcome: CommandOutcome, results: TestResults | undefined, base: BaseRun): CommandOrigin | undefined {
  if (outcome === "passed") return fixedCheck(outcome, base.outcome) ? { cause: "fixed", reason: "the admitted check fails on the base and passes with the change" } : undefined;
  const introduced = introducedTests(results, base.results);
  const cause = checkOrigin(outcome, base.outcome, introduced.length, true, failuresSeenOnBase(results, base.results));
  if (cause === "introduced") {
    return { cause, reason: base.outcome === "passed" ? "it passes on the base" : `these tests fail only with the change: ${introduced.join("; ")}` };
  }
  if (cause === "preexisting") {
    const failing = [...results?.tests ?? []].filter(([, status]) => status === "failed").map(([name]) => name).sort();
    return { cause, reason: `these tests fail on the base too: ${failing.join("; ")}` };
  }
  if (base.outcome !== outcome) return { cause, reason: `on the base it ${base.outcome.replaceAll("_", " ")}` };
  const too = `it ${outcome === "failed" ? "fails" : "runs past its limit"} on the base too`;
  return { cause, reason: results === undefined || base.results === undefined ? `${too}, and no test report says which tests fail`
    : `${too}, and the base's test report doesn't show each of its failing tests failing there` };
}

/**
 * A changed or added test file against the base, the commit the request
 * started from, as two facts apart. Its provenance: the base held the
 * file, so this request changed it, or this request added it, so what it
 * expects is the request's own. Its sensitivity: it fails on the base while
 * the base passes without it, or the tests it adds newly fail there by the
 * base's test reports (`exercise`, `checkOrigin`); or it passes on the base
 * too. A test that notices the change may still expect the wrong thing, and
 * one that passes on the base may still guard against a regression.
 */
export interface TestExercise {
  readonly path: string;
  readonly provenance: "added" | "changed";
  readonly sensitivity: "fails_then_passes" | "passes_on_base" | "unknown";
  readonly reason: string;
  /** Changed source paths whose isolated reversion produced a reported assertion failure in this test file. */
  readonly sources?: readonly string[];
  readonly sourceEvidence?: Evidence;
  readonly sourceGaps?: readonly { readonly path: string; readonly reason: string }[];
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, env: gitEnvironment(cwd), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** Bounded Git with awaited process-tree cancellation for counterfactual work. */
async function sourceGit(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  const output = await gitRead(cwd, args, undefined, signal);
  if (output === undefined) throw new Error(signal.aborted ? "source exercise was stopped or exhausted its budget" : "Git could not prepare source exercise");
  return output;
}

/**
 * The checkout's `node_modules` folders linked into the base worktree, since
 * a worktree holds only tracked files; the links made, in the worktree.
 */
function linkDependencies(root: string, project: string): string[] {
  const links: string[] = [];
  for (const { folder, kinds } of findProjects(root)) {
    const source = join(root, folder, "node_modules");
    const target = join(project, folder, "node_modules");
    if (!kinds.includes("node") || !existsSync(source) || !existsSync(dirname(target)) || existsSync(target)) continue;
    symlinkSync(source, target, "junction");
    links.push(target);
  }
  return links;
}

/**
 * Run `work` in a Git worktree of the base in the computer's temporary
 * folder, at the project's folder inside it, then remove the worktree. The
 * links to the checkout's dependencies go first; when one cannot, the
 * worktree stays rather than risk a removal that follows it into the checkout.
 */
async function atBase<T>(root: string, base: string, work: (project: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const runGit = (cwd: string, args: readonly string[]): Promise<string> => signal === undefined ? git(cwd, args) : sourceGit(cwd, args, signal);
  const prefix = (await runGit(root, ["rev-parse", "--show-prefix"])).trim();
  const directory = mkdtempSync(join(tmpdir(), "tesota-base-"));
  let links: string[] = [];
  try {
    await runGit(root, ["worktree", "add", "--detach", "--quiet", directory, base]);
    const project = join(directory, prefix);
    links = linkDependencies(checkoutRoot(root), checkoutRoot(project));
    return await work(project);
  } finally {
    let unlinked = true;
    for (const link of links) { try { unlinkSync(link); } catch { unlinked = false; } }
    if (unlinked) {
      try { await sourceGit(root, ["worktree", "remove", "--force", directory], AbortSignal.timeout(10_000)); } catch { /* removed below */ }
      rmSync(directory, { recursive: true, force: true });
    }
    await sourceGit(root, ["worktree", "prune"], AbortSignal.timeout(10_000)).catch(() => "");
  }
}

/** A run on the base: how its commands ended, and the tests the JUnit reports it wrote name, if it wrote any. */
interface BaseRun {
  readonly outcome: CommandOutcome;
  readonly results: TestResults | undefined;
  readonly output?: string;
}

/** A declaration always executes in its checkout, even when the verification scope is a subdirectory. */
function executionRoot(scope: string, project: ProjectChecks): string {
  return project.approval === undefined ? scope : checkoutRoot(scope);
}

function checkCommand(scope: string, project: ProjectChecks, check: CheckCommand): string {
  const folder = relative(scope, join(executionRoot(scope, project), check.folder)).replaceAll("\\", "/");
  return inFolder(folder, check.command);
}

async function declarationsAtBase(base: string, projects: readonly ProjectChecks[], signal?: AbortSignal): Promise<string | undefined> {
  const approvals = new Map(projects.flatMap(({ approval }) => approval === undefined ? [] : [[approval.root, approval] as const]));
  for (const approval of approvals.values()) {
    try {
      const args = ["show", `${base}:${checksFile}`];
      const text = signal === undefined ? await git(approval.root, args) : await sourceGit(approval.root, args, signal);
      if (createHash("sha256").update(text).digest("hex") === approval.hash) continue;
    } catch { /* no faithful declaration on the base */ }
    return "the check declarations differ from the base or could not be read there";
  }
  return undefined;
}

/** One invocation, authorized at its original checkout and confined to its actual execution root. */
async function runCheck(root: string, project: ProjectChecks, check: CheckCommand, signal: AbortSignal, env?: Environment): Promise<BaseRun> {
  root = executionRoot(root, project);
  const { folder } = check;
  const { approval } = project;
  const problem = approval === undefined ? project.unavailable : checkApprovalProblem(approval) ?? checkFolderProblem(root, folder);
  if (problem !== undefined) return { outcome: "not_started", output: problem, results: undefined };
  const cwd = join(root, folder);
  if (check.reports !== undefined && clearTestReports(cwd, check.reports).length > 0) {
    return { outcome: "not_started", output: "the declared test report could not be cleared safely", results: undefined };
  }
  const started = Date.now();
  const ran = await runShell(check.command, cwd, signal, check.timeoutMs, env);
  return { ...ran, results: check.reports === undefined ? readTestResults(root, reportsWritten(root, folder, started))
    : readTestResults(cwd, check.reports) };
}

/** The selected project's whole checks run in a base worktree, with the same approval and execution contracts. */
async function baseRun(selected: ProjectChecks, project: string, signal: AbortSignal, env?: Environment): Promise<BaseRun> {
  const { commands, folder } = selected;
  const reports = commands.flatMap((check) => (check.reports ?? []).map((report) => posix.join(check.folder, report)));
  const started = Date.now();
  for (const check of commands) {
    const ran = await runCheck(project, selected, check, signal, env);
    if (ran.outcome !== "passed") return ran;
  }
  return { outcome: "passed", results: reports.length > 0 ? readTestResults(executionRoot(project, selected), reports)
    : readTestResults(project, reportsWritten(project, folder, started)) };
}

/**
 * Whether a test file exercises the change, from the base's run with it and,
 * when that fails, without it. A test that fails before the change, or is
 * missing then, and passes after it, is a fail-to-pass test, as SWE-bench
 * grades one; so the tests that newly fail with the file (`introducedTests`)
 * count even when the base fails without it (`checkOrigin`).
 */
function exercise(path: string, provenance: TestExercise["provenance"], withTest: BaseRun, without: BaseRun | undefined): TestExercise {
  if (withTest.outcome === "passed") {
    return { path, provenance, sensitivity: "passes_on_base", reason: "it passes without the change too" };
  }
  const ended = withTest.outcome.replace("_", " ");
  if (without === undefined) return { path, provenance, sensitivity: "unknown", reason: `on the base it ${ended}` };
  const introduced = introducedTests(withTest.results, without.results).length;
  if (checkOrigin(withTest.outcome, without.outcome, introduced, true, failuresSeenOnBase(withTest.results, without.results)) === "introduced") {
    return { path, provenance, sensitivity: "fails_then_passes", reason: "fails on the base, passes with the change" };
  }
  if (without.outcome === "passed") return { path, provenance, sensitivity: "unknown", reason: `on the base it ${ended}` };
  return { path, provenance, sensitivity: "unknown", reason: withTest.results === undefined || without.results === undefined
    ? `on the base it ${ended}, but so does the base without it, and no test report says which tests fail`
    : `on the base it ${ended}, but so does the base without it, and no test fails there that passes without it` };
}

/**
 * Why a runner's pass shows nothing about `file`, relative to the runner's
 * folder, from the report it wrote: none, or no test from that file ran and
 * passed. A filter that selects nothing passes with no tests, so an exit
 * alone is not a test that ran. Undefined when one did.
 */
function unobserved(results: TestResults | undefined, file: string): string | undefined {
  if (results === undefined) return "the runner wrote no test report Tesota could read whole";
  const statuses = [...results.tests].filter(([name]) => name.startsWith(`${file} > `)).map(([, status]) => status);
  if (statuses.length === 0) return `the runner ran no test from ${file}`;
  return statuses.includes("passed") ? undefined : `every test from ${file} was skipped`;
}

/**
 * The files besides `file` that a runner given only it ran tests from, by
 * its report, as a clause for the reason; empty when none. A filter selects
 * every path that ends the same way, and Bun and Vitest have none that is
 * exact and keeps the project's own selection.
 */
function others(results: TestResults | undefined, file: string): string {
  const ran = [...results?.tests.keys() ?? []].flatMap((name) => name.includes(" > ") ? [name.slice(0, name.indexOf(" > "))] : []);
  const besides = [...new Set(ran)].filter((each) => each !== file).sort();
  return besides.length === 0 ? "" : `, which also ran tests from ${besides.join(", ")}`;
}

/**
 * A file that fails on the base `by` what runs it, credited only when that,
 * `onChange`, passed with the change in the same worktree, so that both
 * sides lack the same files the repository ignores, and, for a runner
 * on the files alone, ran a test from it that passed. Undefined
 * `file` for the whole commands, which name no file.
 */
function credited(verdict: TestExercise, file: string | undefined, by: string, onChange: string, change: BaseRun): TestExercise {
  const but = `it fails on the base ${by}, but with the change in the same worktree, without the checkout's ignored files, ${onChange}`;
  if (change.outcome !== "passed") return { ...verdict, sensitivity: "unknown", reason: `${but} ${change.outcome.replaceAll("_", " ")}` };
  const missing = file === undefined ? undefined : unobserved(change.results, file);
  return missing === undefined ? { ...verdict, reason: `${verdict.reason}; ${by}` }
    : { ...verdict, sensitivity: "unknown", reason: `${but} passed and ${missing}` };
}

/** What the commands a session runs add to Tesota's environment, such as a writing subagent's branch guard. */
export type Environment = Readonly<Record<string, string>>;

/** A path as one word for the POSIX shell the project's checks run in. */
const quoted = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

/**
 * The project's own test runner on `files` alone, relative to its folder,
 * with per-test reporting and empty-suite success. Plain runner scripts only:
 * shell composites cannot safely receive runner flags. Jest takes the files
 * as exact paths and still keeps the project's selection; Bun's exact form,
 * `./`, runs files the project excludes, so Bun and Vitest take them as
 * filters, and what else they ran is said (`others`).
 */
function testProbe(project: string, folder: string, files?: readonly string[]): Probe | undefined {
  const test = packageTest(project, folder);
  if (test === undefined) return undefined;
  return runnerProbe(test.script, test.command, folder, files);
}

/** The same runner reporting contract for whole-project checks and per-file exercise. */
function runnerProbe(script: string, command: string, folder: string, files?: readonly string[]): Probe | undefined {
  // A whole check must keep its selection and reporting semantics; don't override a custom reporter or a watch/bail mode.
  if (files === undefined && /--(?:reporter|outputFile|json|watch|bail|onlyFailures|changed|update)/u.test(script)) return undefined;
  const match = /^(bun test|vitest(?: run)?|jest)(?:\s+[\w./=-]+)*$/u.exec(script.trim());
  if (match === null) return undefined;
  const runner = match[1];
  const name = `.tesota-${files === undefined ? "check" : "exercise"}-${randomUUID()}.${runner === "jest" ? "json" : "xml"}`;
  const flags = runner === "bun test" ? `${files === undefined ? "" : "--pass-with-no-tests "}--reporter=junit --reporter-outfile=${name}`
    : runner === "jest" ? `${files === undefined ? "" : "--passWithNoTests "}--runInBand ${files === undefined ? "" : "--runTestsByPath "}--json --outputFile=${name}`
      : `--run ${files === undefined ? "" : "--passWithNoTests "}--reporter=junit --outputFile=${name}`;
  return { command: [command, flags, ...files?.map(quoted) ?? []].join(" "), folder, report: name,
    bun: runner === "bun test" };
}

/** Name the fallback command, and why a workspace member cannot be probed with its own test script. */
function wholeCheckReason(project: string, folder: string, commands: readonly CheckCommand[]): string {
  const by = `by the whole check, ${commands.map(({ command, folder }) => `\`${inFolder(folder, command)}\``).join(", ")}`;
  if (nearestWorkspaceRoot(project, folder) === undefined) return by;
  const test = packageTest(project, folder);
  const fallback = test === undefined
    ? existsSync(join(project, folder, "package.json")) ? `no test script in ${posix.join(folder, "package.json")}` : "no supported per-file runner"
    : `test script \`${test.script}\` cannot be probed per file`;
  return `${by} (${fallback})`;
}

/** Exercise a member without a test script through the nearest workspace ancestor that has one, never through lint alone. */
function exerciseProject(project: string, projects: readonly ProjectChecks[], path: string): { owning?: ProjectChecks; reason: string } {
  const owning = owningProjects(projects, [path])[0];
  if (owning?.approval !== undefined) return { owning, reason: "" };
  const packages = findProjects(project).filter(({ kinds }) => kinds.includes("node")).map(({ folder }) => ({ folder, commands: [] }));
  const member = owningProjects(packages, [path])[0];
  let workspace = member === undefined ? undefined : nearestWorkspaceRoot(project, member.folder);
  if (workspace === undefined || member === undefined || packageTest(project, member.folder) !== undefined) {
    return owning === undefined ? { reason: "no project's commands run it" } : { owning, reason: "" };
  }
  const missing = [posix.join(member.folder, "package.json")];
  while (workspace !== undefined) {
    const test = packageTest(project, workspace);
    const ancestor = suggestChecks(project).find(({ folder }) => folder === workspace);
    if (test !== undefined && ancestor !== undefined) {
      return { owning: ancestor, reason: `no test script in ${missing.join(" or workspace root ")}; using workspace root ${posix.join(workspace, "package.json")}'s test script \`${test.script}\`` };
    }
    missing.push(posix.join(workspace, "package.json"));
    workspace = nearestWorkspaceRoot(project, workspace);
  }
  return { reason: `test was not run: no test script in ${missing.join(" or workspace root ")}` };
}

/** The runner on some files alone, and the report it writes, relative to its folder. */
interface Probe {
  readonly command: string;
  readonly folder: string;
  readonly report: string;
  readonly bun: boolean;
}

/** Bun 1.4's JUnit omits import/hook errors; require its final summary to account for every failed result. */
function probeResults(probe: Probe, project: string, output: string): TestResults | undefined {
  const results = readTestResults(join(project, probe.folder), [probe.report]);
  if (!probe.bun || results === undefined) return results;
  const plain = stripVTControlCharacters(output);
  const failed = /^\s*(\d+) fail\s*$/mu.exec(plain)?.[1];
  const errors = /^\s*(\d+) errors?\s*$/mu.exec(plain)?.[1];
  const reported = [...results.tests.values()].filter((status) => status === "failed").length;
  return reportCoversFailures(reported, failed === undefined ? -1 : Number(failed), Number(errors ?? 0)) ? results : undefined;
}

/**
 * Read only this invocation's report, never an earlier or linked report,
 * from the runner's folder, so that the tests it names are named by their
 * file there, as the runner was given them.
 */
async function probeRun(probe: Probe, project: string, signal: AbortSignal, env?: Environment, timeoutMs?: number): Promise<BaseRun> {
  const report = posix.join(probe.folder, probe.report);
  if (clearTestReports(project, [report]).length > 0) return { outcome: "not_started", results: undefined };
  try {
    const { outcome, output } = await runShell(probe.command, project, signal, timeoutMs, env);
    return { outcome, output: `Invocation: ${probe.command}\n${output}`,
      results: probeResults(probe, project, output) };
  } finally { clearTestReports(project, [report]); }
}

/**
 * Each test file over the base, by what runs it there: the project's
 * own test runner on that file alone, with per-test reporting, when its test
 * script is one (`testProbe`), else the project's whole commands. A file
 * that fails there runs once more on the base without it: alone, the base's
 * own version of the file, or none; whole, the base as it is, once per
 * folder. Before it credits any file, what ran them runs once more per
 * folder in the same worktree holding the whole change, and must pass
 * (`credited`). Each reason names the command that judged it.
 */
async function againstBase(project: string, root: string, tests: readonly string[], changed: readonly string[],
  provenance: ReadonlyMap<string, TestExercise["provenance"]>, projects: readonly ProjectChecks[], signal: AbortSignal,
  ops: OperationSink, env?: Environment): Promise<TestExercise[]> {
  const found = new Map<string, TestExercise>();
  const reasons = new Map<string, string>();
  const folders = new Map<string, { owning: ProjectChecks; paths: string[] }>();
  for (const path of tests) {
    const { owning, reason } = exerciseProject(project, projects, path);
    if (owning === undefined) {
      found.set(path, { path, provenance: provenance.get(path) ?? "added", sensitivity: "unknown", reason });
    } else {
      if (reason !== "") reasons.set(path, reason);
      const folder = folders.get(owning.folder) ?? { owning, paths: [] };
      folder.paths.push(path);
      folders.set(owning.folder, folder);
    }
  }
  // The worktree holding `paths` as the change leaves them, a path the change removed gone, while `run` runs.
  const holding = async (paths: readonly string[], run: () => Promise<BaseRun>): Promise<BaseRun> => {
    for (const path of paths) {
      const content = bytes(root, path);
      if (content === undefined) { rmSync(join(project, path), { recursive: true, force: true }); continue; }
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), content);
    }
    const ran = await run();
    await git(project, ["reset", "--quiet", "--hard"]);
    await git(project, ["clean", "-qfdx", "-e", "node_modules"]);
    return ran;
  };
  const ended = ({ outcome }: BaseRun): OperationResult => outcome;
  for (const { owning, paths } of folders.values()) {
    const { folder, commands } = owning;
    const alone = (files: readonly string[]): ReturnType<typeof testProbe> =>
      owning.approval === undefined ? testProbe(project, folder, files.map((path) => posix.relative(folder, path))) : undefined;
    let without: BaseRun | undefined;
    // What runs `files` there, once, with the whole change in the same worktree.
    const changes = new Map<string, { target: string; ran: Promise<BaseRun> }>();
    const withChange = (files: readonly string[]): { target: string; ran: Promise<BaseRun> } => {
      const key = files.join("\n");
      const onChange = alone(files);
      const target = onChange?.command ?? commands.map(({ command, folder }) => inFolder(folder, command)).join(" && ");
      const made = changes.get(key) ?? { target, ran: holding(changed, () => ops.run({ method: "command", unit: "", target },
        () => onChange === undefined ? baseRun(owning, project, signal, env) : probeRun(onChange, project, signal, env), ended)) };
      changes.set(key, made);
      return made;
    };
    // What runs each file there is what the operations name: the runner on the file alone, else the project's whole commands.
    const probes = new Map(paths.map((path) => [path, alone([path])] as const));
    const target = (path: string): string => probes.get(path)?.command ?? commands.map(({ command, folder }) => inFolder(folder, command)).join(" && ");
    const planned = new Map(paths.map((path) => [path, ops.plan({ method: "exercise", unit: "", target: target(path) })] as const));
    for (const path of paths) {
      const origin = provenance.get(path) ?? "added";
      const probe = probes.get(path);
      const exercising: OperationSpec = { method: "exercise", unit: "", target: target(path) };
      const parent = planned.get(path);
      const control: OperationSpec = { method: "base_control", unit: "", target: target(path), ...parent === undefined ? {} : { parent } };
      if (probe === undefined) {
        const withTest = await holding([path], () => ops.run(exercising, () => baseRun(owning, project, signal, env), ended, planned.get(path)));
        if (withTest.outcome !== "passed") {
          without ??= await ops.run(control, () => baseRun(owning, project, signal, env), ended);
        }
        const verdict = exercise(path, origin, withTest, without);
        const by = wholeCheckReason(project, folder, commands);
        found.set(path, verdict.sensitivity === "fails_then_passes" ? credited(verdict, undefined, by, "it", await withChange(paths).ran)
          : { ...verdict, reason: `${verdict.reason}; ${by}` });
        continue;
      }
      const withTest = await holding([path], () => ops.run(exercising, () => probeRun(probe, project, signal, env), ended, planned.get(path)));
      const file = posix.relative(folder, path);
      const by = `by \`${probe.command}\`${others(withTest.results, file)}`;
      const unseen = withTest.outcome === "passed" ? unobserved(withTest.results, file) : undefined;
      if (unseen !== undefined) {
        found.set(path, { path, provenance: origin, sensitivity: "unknown", reason: `on the base it passed, but ${unseen}; ${by}` });
        continue;
      }
      const verdict = exercise(path, origin, withTest, withTest.outcome === "passed" ? undefined
        : await ops.run(control, () => probeRun(probe, project, signal, env), ended));
      if (verdict.sensitivity !== "fails_then_passes") { found.set(path, { ...verdict, reason: `${verdict.reason}; ${by}` }); continue; }
      // The folder's files together, then, when another of them fails there, this file alone.
      let change = withChange(paths);
      if ((await change.ran).outcome !== "passed" && paths.length > 1) change = withChange([path]);
      found.set(path, credited(verdict, file, by, `\`${change.target}\``, await change.ran));
    }
  }
  return tests.flatMap((path) => {
    const exercise = found.get(path);
    const reason = reasons.get(path);
    return exercise === undefined ? [] : { ...exercise, reason: reason === undefined ? exercise.reason : `${exercise.reason}; ${reason}` };
  });
}

/** Files that decide a JavaScript project's dependencies, which the base takes from the checkout. */
const dependencyFiles: ReadonlySet<string> = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock",
  "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]);

/** A checkout-wide declaration also borrows dependencies outside a nested verification scope. */
async function baseConfigurationProblem(root: string, base: string, changed: readonly string[], projects: readonly ProjectChecks[],
  signal: AbortSignal): Promise<string | undefined> {
  let paths = changed;
  if (projects.some(({ approval }) => approval !== undefined)) {
    const checkout = checkoutRoot(root);
    const [tracked, untracked] = await Promise.all([
      gitRead(checkout, ["diff", "--no-renames", "--name-only", "-z", base, "--"], undefined, signal),
      gitRead(checkout, ["ls-files", "--others", "--exclude-standard", "-z"], undefined, signal),
    ]);
    if (tracked === undefined || untracked === undefined) return "the checkout's dependency changes could not be read for the base comparison";
    paths = [...changed, ...tracked.split("\0"), ...untracked.split("\0")];
  }
  const touched = [...new Set(paths.filter((path) => dependencyFiles.has(posix.basename(path)) || path === checksFile))];
  return touched.length === 0 ? undefined
    : `the change touches ${touched.join(", ")}, and the base runs with the checkout's dependencies, so a run there may not be faithful`;
}

/**
 * Each changed or added test file, as the change leaves it, run alone over
 * the base: its project's test runner on that file, or else its project's
 * commands (`againstBase`), run in a worktree of `base` holding only that
 * file from the change, and once more holding none of it when the file
 * fails there, to tell a test that fails because the change is missing from
 * a base that fails anyway. The base runs with the checkout's dependencies,
 * so when the change touches what decides them, no run there is faithful
 * and none gives a verdict.
 */
export async function exerciseTests(root: string, base: string, tests: readonly string[], changed: readonly string[],
  projects: readonly ProjectChecks[], signal: AbortSignal, ops: OperationSink = noOperations, env?: Environment): Promise<TestExercise[]> {
  if (tests.length === 0) return [];
  const provenance = new Map(await Promise.all(tests.map(async (path) => [path, await atCommit(root, base, path) ? "changed" : "added"] as const)));
  const unknown = (reason: string): TestExercise[] =>
    tests.map((path) => ({ path, provenance: provenance.get(path) ?? "added", sensitivity: "unknown", reason }));
  const configurationProblem = await baseConfigurationProblem(root, base, changed, projects, signal);
  if (configurationProblem !== undefined) return unknown(configurationProblem);
  const declarationProblem = await declarationsAtBase(base, projects);
  if (declarationProblem !== undefined) return unknown(declarationProblem);
  try {
    return await atBase(root, base, (project) => againstBase(project, root, tests, changed, provenance, projects, signal, ops, env));
  } catch (error) {
    const why = error instanceof Error ? error.message.trim().split("\n").at(-1) ?? "" : String(error);
    return unknown(`the base could not be checked out: ${why}`);
  }
}

export interface SourceExercise {
  readonly sources: readonly string[];
  readonly sourceGaps: readonly { readonly path: string; readonly reason: string }[];
  readonly sourceEvidence?: Evidence;
}

/** Copy the candidate into disposable state; never follow a changed link or treat an unreadable file as deleted. */
async function sourceCandidate(project: string, root: string, changed: readonly string[], signal: AbortSignal): Promise<void> {
  await sourceGit(project, ["reset", "--quiet", "--hard"], signal);
  await sourceGit(project, ["clean", "-qfdx", "-e", "node_modules"], signal);
  for (const path of changed) {
    if (signal.aborted) throw new Error("source exercise was stopped or exhausted its budget");
    if (!confinedPath(project, path) || !confinedPath(root, path)) throw new Error(`source exercise cannot copy ${path} safely`);
    const target = join(project, path);
    if (!existsSync(join(root, path))) { rmSync(target, { force: true }); continue; }
    if (!lstatSync(join(root, path)).isFile()) throw new Error(`source exercise cannot copy ${path} as a regular file`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(root, path)));
  }
}

function candidateHash(root: string, changed: readonly string[]): string {
  return contentHash(changed.map((path) => ({ path, content: read(root, path) })));
}

function sourceControlHeld(project: string, root: string, changed: readonly string[], hash: string, run: BaseRun): boolean {
  return run.outcome === "passed" && candidateHash(project, changed) === hash && candidateHash(root, changed) === hash;
}

/** Newly failing assertions in a named test file, never import, setup or unclassified runtime failures. */
function sourceNoticed(control: BaseRun, reverted: BaseRun, file: string): boolean {
  const matching = [...reverted.results?.assertionFailures ?? []].filter((name) =>
    name.startsWith(`${file} > `) && control.results?.tests.get(name) === "passed");
  return sourceAssertion(control.outcome, reverted.outcome, matching.length);
}

/** Ignored local inputs are not copied, especially secrets; only the dependency directories actually borrowed are supported. */
async function sourceLocalInputs(root: string, project: string, signal: AbortSignal): Promise<void> {
  const original = checkoutRoot(root);
  const candidate = checkoutRoot(project);
  const ignored = (await sourceGit(original, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], signal))
    .split("\0").filter(Boolean);
  for (const path of ignored) {
    const clean = path.replace(/\/$/u, "");
    try {
      if (clean.split("/").at(-1) === "node_modules" && lstatSync(join(candidate, clean)).isSymbolicLink()
        && realpathSync(join(candidate, clean)) === realpathSync(join(original, clean))) continue;
    } catch { /* an unavailable local input is not faithfully borrowed */ }
    throw new Error("ignored local inputs cannot be faithfully materialized for source exercise");
  }
}

/** Only a confirmed absent entry is removed; an unreadable blob must never masquerade as an added source. */
async function restoreSource(project: string, base: string, source: string, signal: AbortSignal): Promise<void> {
  const entry = await sourceGit(project, ["ls-tree", "-z", base, "--", `:(literal)${source}`], signal);
  if (entry === "") { rmSync(join(project, source), { force: true }); return; }
  if (!/^100(?:644|755) blob [a-f\d]+\t/u.test(entry)) throw new Error(`the base source ${source} is not a regular file`);
  const before = await sourceGit(project, ["show", `${base}:./${source}`], signal);
  writeFileSync(join(project, source), before);
}

/**
 * Counterfactual per-source sensitivity. Every probe starts with the full candidate and reverts exactly one source.
 * The shared deadline includes setup and controls; process cleanup is awaited even after its measurement budget expires.
 */
export async function exerciseSourcePaths(root: string, base: string, tests: readonly string[], changed: readonly string[],
  projects: readonly ProjectChecks[], signal: AbortSignal, ops: OperationSink = noOperations, env?: Environment,
  deadline: number = performance.now() + 120_000): Promise<ReadonlyMap<string, SourceExercise>> {
  // runShell also serves model checks before the first frame; keep parser-backed classification at settlement.
  const { isSourcePath, isTestPath } = await import("./verification-changes.js");
  const sources = changed.filter((path) => isSourcePath(path) && !isTestPath(path)).sort();
  const found = new Map<string, SourceExercise>(tests.map((path) => [path, { sources: [], sourceGaps: [] }]));
  if (sources.length === 0 || tests.length === 0) return found;
  const unknown = (reason: string): ReadonlyMap<string, SourceExercise> => new Map(tests.map((path) => [path,
    { sources: [], sourceGaps: sources.map((source) => ({ path: source, reason })) }]));
  if (performance.now() >= deadline) return unknown("the shared source-exercise budget was exhausted");
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())))]);
  const problem = await baseConfigurationProblem(root, base, changed, projects, bounded) ?? await declarationsAtBase(base, projects, bounded);
  if (problem !== undefined) return unknown(problem);
  const hash = candidateHash(root, changed);
  const started = performance.now();
  try {
    await atBase(root, base, async (project) => {
      await sourceLocalInputs(root, project, bounded);
      for (const selected of projects) {
        const paths = tests.filter((path) => exerciseProject(root, projects, path).owning?.folder === selected.folder);
        if (paths.length === 0) continue;
        const selectedSources = sources.filter((path) => exerciseProject(root, projects, path).owning?.folder === selected.folder);
        const probe = selected.approval === undefined ? testProbe(root, selected.folder, paths.map((path) => posix.relative(selected.folder, path))) : undefined;
        if (probe === undefined) {
          for (const path of paths) found.set(path, { sources: [], sourceGaps: selectedSources.map((source) =>
            ({ path: source, reason: "no supported targeted runner can measure source sensitivity" })) });
          continue;
        }
        await sourceCandidate(project, root, changed, bounded);
        const control = await ops.run({ method: "source_exercise", unit: "", target: probe.command },
          () => probeRun(probe, project, bounded, env), (ran) => ran.outcome);
        if (!sourceControlHeld(project, root, changed, hash, control)) throw new Error("the candidate control did not pass unchanged in the source-exercise worktree");
        const noticed = new Map(paths.map((path) => [path, [] as string[]]));
        const gaps = new Map(paths.map((path) => [path, [] as { path: string; reason: string }[]]));
        for (const source of selectedSources) {
          if (bounded.aborted) {
            for (const path of paths) gaps.get(path)?.push({ path: source, reason: "source exercise was stopped or exhausted its shared budget" });
            continue;
          }
          await sourceCandidate(project, root, changed, bounded);
          await restoreSource(project, base, source, bounded);
          const reverted = await ops.run({ method: "source_exercise", unit: "", target: source },
            () => probeRun(probe, project, bounded, env), (ran) => ran.outcome);
          for (const path of paths) {
            if (sourceNoticed(control, reverted, posix.relative(selected.folder, path))) noticed.get(path)?.push(source);
            else gaps.get(path)?.push({ path: source, reason: "the isolated reversion produced no attributable assertion failure in this test file" });
          }
        }
        // A fresh confirmation guards runner-written candidate changes and a failed final control; partial results are never promoted.
        await sourceCandidate(project, root, changed, bounded);
        const confirmed = await ops.run({ method: "source_exercise", unit: "", target: probe.command },
          () => probeRun(probe, project, bounded, env), (ran) => ran.outcome);
        if (!sourceControlHeld(project, root, changed, hash, confirmed)) {
          throw new Error("the source-exercise confirmation did not pass on the unchanged candidate");
        }
        await sourceLocalInputs(root, project, bounded);
        for (const path of paths) found.set(path, { sources: noticed.get(path) ?? [], sourceGaps: gaps.get(path) ?? [],
          sourceEvidence: { verifier: "command", claim: "reported assertions notice the listed source reversions", limits:
            "Only named assertion failures from isolated source reversions; this does not establish intended behavior or full coverage.",
          outcome: "passed", output: `Control and confirmation: ${probe.command}`, durationMs: performance.now() - started, files: changed, contentHash: hash } });
      }
    }, bounded);
    return found;
  } catch (error) { return unknown(error instanceof Error ? error.message : String(error)); }
}

/** Whether the commit `base` holds a file at `path`, relative to `root`; a folder there is not the file. */
export async function atCommit(root: string, base: string, path: string): Promise<boolean> {
  try { return (await git(root, ["cat-file", "-t", `${base}:./${path}`])).trim() === "blob"; } catch { return false; }
}
