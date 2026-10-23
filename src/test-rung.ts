import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { type Evidence, contentHash } from "./evidence.js";
import { gitEnvironment } from "./git.js";
import { type ProjectChecks, findProjects, owningProjects, packageTest } from "./projects.js";
import { runProcess } from "./process.js";
import { clearTestReports, introducedTests, readTestResults, type TestResults } from "./test-report.js";
import { type CheckOutcome, checkOrigin } from "./verification/check-origin-rule.js";
import { host } from "./host.js";
import { noOperations, type OperationResult, type OperationSink, type OperationSpec } from "./operations.js";

const execFileAsync = promisify(execFile);

/** How a command run ended. */
export type CommandOutcome = Extract<CheckOutcome, "passed" | "failed" | "timed_out" | "cancelled" | "not_started">;

const defaultTimeoutMs = 15 * 60_000;

/**
 * Run one of the project's checks in the shell the engine gives for them (`HostParts.shellConfig`),
 * from `cwd`, through `runProcess`.
 */
export async function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number = defaultTimeoutMs):
  Promise<{ outcome: CommandOutcome; output: string }> {
  let config: ReturnType<ReturnType<typeof host>["shellConfig"]>;
  try { config = host().shellConfig(); } catch (error) {
    return { outcome: "not_started", output: error instanceof Error ? error.message : String(error) };
  }
  if (config.commandTransport === "stdin") {
    return { outcome: "not_started", output: `${config.shell} reads commands from its input, which Tesota cannot give it.` };
  }
  const { ended, exitCode, output } = await runProcess(config.shell, [...config.args, command], cwd, signal, timeoutMs);
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
  readonly evidence: Evidence;
  /** The failing tests' names, sorted, from the JUnit reports the run wrote; undefined when it wrote none. */
  readonly failingTests?: readonly string[] | undefined;
}

const limits = "Shows only that the project's commands passed on these files; it says nothing about what the tests " +
  "leave unchecked.";

function read(root: string, path: string): string | undefined {
  try { return readFileSync(join(root, path), "utf8"); } catch { return undefined; }
}

/**
 * Run the commands of the projects that own the changed files at `root`, one
 * evidence each, bound to the changed files' content as it was when the
 * commands started.
 */
export async function runCommands(root: string, projects: readonly ProjectChecks[], changed: readonly string[],
  signal: AbortSignal, ops: OperationSink = noOperations): Promise<CommandRun[]> {
  const hash = contentHash(changed.map((path) => ({ path, content: read(root, path) })));
  const runs: CommandRun[] = [];
  const spec = (command: string): OperationSpec => ({ method: "command", unit: "", target: command });
  const planned = projects.flatMap(({ commands }) => commands).map((command) => ops.plan(spec(command)));
  let next = 0;
  for (const { folder, commands } of projects) {
    for (const command of commands) {
      const started = Date.now();
      // After a stop nothing is launched, so no start is published and the planned command closes as not started (#590).
      const id = planned[next++];
      const { outcome, output } = signal.aborted ? await runShell(command, root, signal)
        : await ops.run(spec(command), () => runShell(command, root, signal), (ran) => ran.outcome, id);
      const results = readTestResults(root, reportsWritten(root, folder, started));
      const failingTests = results === undefined ? undefined
        : [...results.tests].filter(([, status]) => status === "failed").map(([name]) => name).sort();
      runs.push({ command, failingTests, evidence: { verifier: "command", claim: `\`${command}\` passes with these changes.`,
        limits, outcome, output, durationMs: Date.now() - started, files: changed, contentHash: hash } });
    }
  }
  return runs;
}

/**
 * A changed or added test file against the base, the commit the request
 * started from (#527), as two facts apart. Its provenance: the base held the
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
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, env: gitEnvironment(cwd), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** The outcome of a sequence of commands: the first that did not pass, else passed. */
async function runAll(commands: readonly string[], cwd: string, signal: AbortSignal): Promise<CommandOutcome> {
  for (const command of commands) {
    const { outcome } = await runShell(command, cwd, signal);
    if (outcome !== "passed") return outcome;
  }
  return "passed";
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
async function atBase<T>(root: string, base: string, work: (project: string) => Promise<T>): Promise<T> {
  const prefix = (await git(root, ["rev-parse", "--show-prefix"])).trim();
  const directory = mkdtempSync(join(tmpdir(), "tesota-base-"));
  let links: string[] = [];
  try {
    await git(root, ["worktree", "add", "--detach", "--quiet", directory, base]);
    const project = join(directory, prefix);
    links = linkDependencies(root, project);
    return await work(project);
  } finally {
    let unlinked = true;
    for (const link of links) { try { unlinkSync(link); } catch { unlinked = false; } }
    if (unlinked) {
      try { await git(root, ["worktree", "remove", "--force", directory]); } catch { /* removed below */ }
      rmSync(directory, { recursive: true, force: true });
    }
    await git(root, ["worktree", "prune"]).catch(() => "");
  }
}

/** A run on the base: how its commands ended, and the tests the JUnit reports it wrote name, if it wrote any. */
interface BaseRun {
  readonly outcome: CommandOutcome;
  readonly results: TestResults | undefined;
}

/** `commands` run in `project`, a worktree of the base, with the reports they wrote under the owning `folder`. */
async function baseRun(commands: readonly string[], project: string, folder: string, signal: AbortSignal): Promise<BaseRun> {
  const started = Date.now();
  const outcome = await runAll(commands, project, signal);
  return { outcome, results: readTestResults(project, reportsWritten(project, folder, started)) };
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
  if (checkOrigin(withTest.outcome, without.outcome, introduced, true) === "introduced") {
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
 * alone is not a test that ran (#615). Undefined when one did.
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
 * exact and keeps the project's own selection (#620).
 */
function others(results: TestResults | undefined, file: string): string {
  const ran = [...results?.tests.keys() ?? []].flatMap((name) => name.includes(" > ") ? [name.slice(0, name.indexOf(" > "))] : []);
  const besides = [...new Set(ran)].filter((each) => each !== file).sort();
  return besides.length === 0 ? "" : `, which also ran tests from ${besides.join(", ")}`;
}

/**
 * A file that fails on the base `by` its runner alone, credited only when
 * that runner on the change, `onChange`, passed and ran a test from it that
 * passed (#615).
 */
function credited(verdict: TestExercise, file: string, by: string, onChange: string, change: BaseRun): TestExercise {
  if (change.outcome !== "passed") {
    return { ...verdict, sensitivity: "unknown", reason: `it fails on the base ${by}, but on the change ${onChange} ${change.outcome.replaceAll("_", " ")}` };
  }
  const missing = unobserved(change.results, file);
  return missing === undefined ? { ...verdict, reason: `${verdict.reason}, ${by}` }
    : { ...verdict, sensitivity: "unknown", reason: `it fails on the base ${by}, but on the change ${onChange} passed and ${missing}` };
}

/** A path as one word for the POSIX shell the project's checks run in. */
const quoted = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

/**
 * The project's own test runner on `files` alone, relative to its folder,
 * with per-test reporting and empty-suite success. Plain runner scripts only:
 * shell composites cannot safely receive runner flags. Jest takes the files
 * as exact paths and still keeps the project's selection; Bun's exact form,
 * `./`, runs files the project excludes, so Bun and Vitest take them as
 * filters, and what else they ran is said (`others`, #620).
 */
function testProbe(project: string, folder: string, files: readonly string[]): Probe | undefined {
  const test = packageTest(project, folder);
  if (test === undefined) return undefined;
  const match = /^(bun test|vitest(?: run)?|jest)(?:\s+[\w./=-]+)*$/u.exec(test.script.trim());
  if (match === null) return undefined;
  const runner = match[1];
  const name = `.tesota-exercise-${randomUUID()}.${runner === "jest" ? "json" : "xml"}`;
  const flags = runner === "bun test" ? `--pass-with-no-tests --reporter=junit --reporter-outfile=${name}`
    : runner === "jest" ? `--passWithNoTests --runInBand --runTestsByPath --json --outputFile=${name}`
      : `--run --passWithNoTests --reporter=junit --outputFile=${name}`;
  return { command: [test.command, flags, ...files.map(quoted)].join(" "), folder, report: name };
}

/** The runner on some files alone, and the report it writes, relative to its folder. */
interface Probe {
  readonly command: string;
  readonly folder: string;
  readonly report: string;
}

/**
 * Read only this invocation's report, never an earlier or linked report,
 * from the runner's folder, so that the tests it names are named by their
 * file there, as the runner was given them.
 */
async function probeRun(probe: Probe, project: string, signal: AbortSignal): Promise<BaseRun> {
  const report = posix.join(probe.folder, probe.report);
  if (clearTestReports(project, [report]).length > 0) return { outcome: "not_started", results: undefined };
  try {
    const outcome = await runAll([probe.command], project, signal);
    return { outcome, results: readTestResults(join(project, probe.folder), [probe.report]) };
  } finally { clearTestReports(project, [report]); }
}

/**
 * Each test file over the base, by what runs it there (#603): the project's
 * own test runner on that file alone, with per-test reporting, when its test
 * script is one (`testProbe`), else the project's whole commands. A file
 * that fails there runs once more on the base without it: alone, the base's
 * own version of the file, or none; whole, the base as it is, once per
 * folder. A runner on the files alone also runs them on the change, once per
 * folder, which must pass before it credits any file. Each reason names the
 * command that judged it.
 */
async function againstBase(project: string, root: string, tests: readonly string[], provenance: ReadonlyMap<string, TestExercise["provenance"]>,
  projects: readonly ProjectChecks[], signal: AbortSignal, ops: OperationSink): Promise<TestExercise[]> {
  const found = new Map<string, TestExercise>();
  const folders = new Map<string, { owning: ProjectChecks; paths: string[] }>();
  for (const path of tests) {
    const owning = owningProjects(projects, [path])[0];
    if (owning === undefined) {
      found.set(path, { path, provenance: provenance.get(path) ?? "added", sensitivity: "unknown", reason: "no project's commands run it" });
    } else {
      const folder = folders.get(owning.folder) ?? { owning, paths: [] };
      folder.paths.push(path);
      folders.set(owning.folder, folder);
    }
  }
  const holding = async (path: string, run: () => Promise<BaseRun>): Promise<BaseRun> => {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), read(root, path) ?? "");
    const ran = await run();
    await git(project, ["reset", "--quiet", "--hard"]);
    await git(project, ["clean", "-qfdx", "-e", "node_modules"]);
    return ran;
  };
  for (const { owning: { folder, commands }, paths } of folders.values()) {
    const alone = (files: readonly string[]): ReturnType<typeof testProbe> =>
      testProbe(project, folder, files.map((path) => posix.relative(folder, path)));
    let without: BaseRun | undefined;
    let change: BaseRun | undefined;
    // What runs each file there is what the operations name: the runner on the file alone, else the project's whole commands.
    const probes = new Map(paths.map((path) => [path, alone([path])] as const));
    const target = (path: string): string => probes.get(path)?.command ?? commands.join(" && ");
    const planned = new Map(paths.map((path) => [path, ops.plan({ method: "exercise", unit: "", target: target(path) })] as const));
    const ended = ({ outcome }: BaseRun): OperationResult => outcome;
    for (const path of paths) {
      const origin = provenance.get(path) ?? "added";
      const probe = probes.get(path);
      const exercising: OperationSpec = { method: "exercise", unit: "", target: target(path) };
      const parent = planned.get(path);
      const control: OperationSpec = { method: "base_control", unit: "", target: target(path), ...parent === undefined ? {} : { parent } };
      if (probe === undefined) {
        const withTest = await holding(path, () => ops.run(exercising, () => baseRun(commands, project, folder, signal), ended, planned.get(path)));
        if (withTest.outcome !== "passed") {
          without ??= await ops.run(control, () => baseRun(commands, project, folder, signal), ended);
        }
        const verdict = exercise(path, origin, withTest, without);
        found.set(path, { ...verdict, reason: `${verdict.reason}; by the whole check, ${commands.map((command) => `\`${command}\``).join(", ")}` });
        continue;
      }
      const withTest = await holding(path, () => ops.run(exercising, () => probeRun(probe, project, signal), ended, planned.get(path)));
      const file = posix.relative(folder, path);
      const by = `by \`${probe.command}\`${others(withTest.results, file)}`;
      const unseen = withTest.outcome === "passed" ? unobserved(withTest.results, file) : undefined;
      if (unseen !== undefined) {
        found.set(path, { path, provenance: origin, sensitivity: "unknown", reason: `on the base it passed, but ${unseen}; ${by}` });
        continue;
      }
      const verdict = exercise(path, origin, withTest, withTest.outcome === "passed" ? undefined
        : await ops.run(control, () => probeRun(probe, project, signal), ended));
      if (verdict.sensitivity !== "fails_then_passes") { found.set(path, { ...verdict, reason: `${verdict.reason}; ${by}` }); continue; }
      const onChange = alone(paths);
      change ??= onChange === undefined ? { outcome: "not_started", results: undefined }
        : await ops.run({ method: "command", unit: "", target: onChange.command }, () => probeRun(onChange, root, signal), ended);
      found.set(path, credited(verdict, file, by, `\`${onChange?.command ?? probe.command}\``, change));
    }
  }
  return tests.flatMap((path) => found.get(path) ?? []);
}

/** Files that decide a JavaScript project's dependencies, which the base takes from the checkout. */
const dependencyFiles: ReadonlySet<string> = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock",
  "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]);

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
  projects: readonly ProjectChecks[], signal: AbortSignal, ops: OperationSink = noOperations): Promise<TestExercise[]> {
  if (tests.length === 0) return [];
  const provenance = new Map(await Promise.all(tests.map(async (path) => [path, await atCommit(root, base, path) ? "changed" : "added"] as const)));
  const unknown = (reason: string): TestExercise[] =>
    tests.map((path) => ({ path, provenance: provenance.get(path) ?? "added", sensitivity: "unknown", reason }));
  const touched = changed.filter((path) => dependencyFiles.has(posix.basename(path)));
  if (touched.length > 0) {
    return unknown(`the change touches ${touched.join(", ")}, and the base runs with the checkout's dependencies, so a run there may not be faithful`);
  }
  try {
    return await atBase(root, base, (project) => againstBase(project, root, tests, provenance, projects, signal, ops));
  } catch (error) {
    const why = error instanceof Error ? error.message.trim().split("\n").at(-1) ?? "" : String(error);
    return unknown(`the base could not be checked out: ${why}`);
  }
}

/** Whether the commit `base` holds a file at `path`, relative to `root`; a folder there is not the file. */
export async function atCommit(root: string, base: string, path: string): Promise<boolean> {
  try { return (await git(root, ["cat-file", "-t", `${base}:./${path}`])).trim() === "blob"; } catch { return false; }
}
