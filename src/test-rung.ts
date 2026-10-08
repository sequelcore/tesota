import { execFile, spawn } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { type Evidence, contentHash } from "./evidence.js";
import { type ProjectChecks, findProjects, owningProjects } from "./projects.js";
import { readTestResults } from "./test-report.js";
import { type CheckOutcome, checkOrigin } from "./verification/check-origin-rule.js";

const execFileAsync = promisify(execFile);

/** How a command run ended. */
export type CommandOutcome = Extract<CheckOutcome, "passed" | "failed" | "timed_out" | "cancelled" | "not_started">;

const defaultTimeoutMs = 15 * 60_000;
const outputLimit = 8 * 1024;
// A shell that exits while a descendant still holds its output never closes it; the run ends this long after the exit.
const closeGraceMs = 2_000;

/** Stop a process and every process it started: `taskkill /T` on Windows, the process group elsewhere. */
function stopTree(pid: number): void {
  if (process.platform === "win32") {
    spawn(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(pid)],
      { stdio: "ignore", windowsHide: true }).once("error", () => undefined);
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
}

/**
 * Run one command in Pi's shell, the one its `bash` tool runs the agent's
 * commands in, from `cwd`. A run past `timeoutMs`, or one `signal` stops,
 * ends with every process it started.
 */
export function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number = defaultTimeoutMs):
  Promise<{ outcome: CommandOutcome; output: string }> {
  let config: ReturnType<typeof getShellConfig>;
  try { config = getShellConfig(); } catch (error) {
    return Promise.resolve({ outcome: "not_started", output: error instanceof Error ? error.message : String(error) });
  }
  if (config.commandTransport === "stdin") {
    return Promise.resolve({ outcome: "not_started", output: `${config.shell} reads commands from its input, which Tesota cannot give it.` });
  }
  if (signal.aborted) return Promise.resolve({ outcome: "cancelled", output: "" });
  return new Promise((settle) => {
    let output = "";
    let timedOut = false;
    const child = spawn(config.shell, [...config.args, command], { cwd, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"] });
    const append = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-outputLimit); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = (): void => { if (child.pid !== undefined) stopTree(child.pid); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    let grace: NodeJS.Timeout | undefined;
    const finish = (outcome: CommandOutcome): void => {
      clearTimeout(timer);
      clearTimeout(grace);
      signal.removeEventListener("abort", stop);
      settle({ outcome, output });
    };
    const ended = (code: number | null): CommandOutcome =>
      signal.aborted ? "cancelled" : timedOut ? "timed_out" : code === 0 ? "passed" : "failed";
    child.once("error", (error) => { output = error.message; finish("not_started"); });
    child.once("exit", (code) => { grace = setTimeout(() => { finish(ended(code)); }, closeGraceMs); });
    child.once("close", (code) => { finish(ended(code)); });
  });
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
  signal: AbortSignal): Promise<CommandRun[]> {
  const hash = contentHash(changed.map((path) => ({ path, content: read(root, path) })));
  const runs: CommandRun[] = [];
  for (const { folder, commands } of projects) {
    for (const command of commands) {
      const started = Date.now();
      const { outcome, output } = await runShell(command, root, signal);
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
 * Whether a changed or added test exercises the change: it does not when it
 * passes on the base, the commit the request started from; it does when it
 * fails there while the base passes without it (`checkOrigin`).
 */
export interface TestExercise {
  readonly path: string;
  readonly finding: "exercises" | "does_not_exercise" | "unknown";
  readonly reason: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
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

function exercise(path: string, withTest: CommandOutcome, without: CommandOutcome | undefined): TestExercise {
  if (withTest === "passed") {
    return { path, finding: "does_not_exercise", reason: "it passes without the change" };
  }
  if (without !== undefined && checkOrigin(withTest, without, 0, true) === "introduced") {
    return { path, finding: "exercises", reason: "it fails without the change, and the base passes without it" };
  }
  const ended = withTest.replace("_", " ");
  return { path, finding: "unknown", reason: without === undefined
    ? `on the base it ${ended}`
    : `on the base it ${ended}, and the base also ends ${without.replace("_", " ")} without it` };
}

/**
 * Each test file's run over the base with its project's commands, then that
 * project's own run on the base, once, when some of its tests fail there.
 */
async function againstBase(project: string, root: string, tests: readonly string[], projects: readonly ProjectChecks[],
  signal: AbortSignal): Promise<TestExercise[]> {
  const found: TestExercise[] = [];
  const without = new Map<string, CommandOutcome>();
  for (const path of tests) {
    const owning = owningProjects(projects, [path])[0];
    if (owning === undefined) {
      found.push({ path, finding: "unknown", reason: "no project's commands run it" });
      continue;
    }
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), read(root, path) ?? "");
    const withTest = await runAll(owning.commands, project, signal);
    await git(project, ["reset", "--quiet", "--hard"]);
    await git(project, ["clean", "-qfdx", "-e", "node_modules"]);
    if (withTest !== "passed" && !without.has(owning.folder)) {
      without.set(owning.folder, await runAll(owning.commands, project, signal));
    }
    found.push(exercise(path, withTest, without.get(owning.folder)));
  }
  return found;
}

/** Files that decide a JavaScript project's dependencies, which the base takes from the checkout. */
const dependencyFiles: ReadonlySet<string> = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock",
  "bun.lockb", "pnpm-lock.yaml", "yarn.lock"]);

/**
 * Each changed or added test file, as the change leaves it, run alone over
 * the base: its project's commands run in a worktree of `base` holding only
 * that file from the change, and once more holding none of it when the file
 * fails there, to tell a test that fails because the change is missing from
 * a base that fails anyway. The base runs with the checkout's dependencies,
 * so when the change touches what decides them, no run there is faithful
 * and none gives a verdict.
 */
export async function exerciseTests(root: string, base: string, tests: readonly string[], changed: readonly string[],
  projects: readonly ProjectChecks[], signal: AbortSignal): Promise<TestExercise[]> {
  if (tests.length === 0) return [];
  const touched = changed.filter((path) => dependencyFiles.has(posix.basename(path)));
  if (touched.length > 0) {
    return tests.map((path) => ({ path, finding: "unknown", reason: `the change touches ${touched.join(", ")}, and the ` +
      "base runs with the checkout's dependencies, so a run there may not be faithful" }));
  }
  try {
    return await atBase(root, base, (project) => againstBase(project, root, tests, projects, signal));
  } catch (error) {
    const why = error instanceof Error ? error.message.trim().split("\n").at(-1) ?? "" : String(error);
    return tests.map((path) => ({ path, finding: "unknown", reason: `the base could not be checked out: ${why}` }));
  }
}
