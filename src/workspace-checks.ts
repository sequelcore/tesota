import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnvironmentGuarantees, ExecutionEnvironment } from "./execution-environment.js";
import { terminalOutputText } from "./terminal-output.js";
import { clearTestReports, introducedTests, MAX_CHECK_REPORTS, normalizeReportPath, readTestResults,
  type TestResults } from "./test-report.js";
import { type CheckOrigin, type CheckOutcome, checkOrigin } from "./verification/check-origin-rule.js";
import type { WorkspaceSnapshot } from "./workspace.js";

/**
 * Where a check's base run happens: `directory` holds the files and the
 * reports it writes, `root` is set when that is not the checkout, and the
 * environment must then show it at the checkout's path, and `intact` says
 * whether it still holds exactly the base.
 */
export interface BasePlace {
  readonly directory: string;
  readonly root?: string;
  intact(): boolean;
}

/** What checks run on: a workspace, or a session working in the source itself. */
export interface CheckTarget {
  readonly checkout: string;
  /** Whether the base runs in a folder of its own, which only an environment that `runsInOtherFolders` can show. */
  readonly basesInOtherFolder: boolean;
  ignores(path: string): boolean;
  /** The tree the checkout holds now. */
  currentTree(): string;
  /** Run `work` while the snapshot's base is in place, then put back what was there. */
  atBase<T>(snapshot: WorkspaceSnapshot, work: (base: BasePlace) => Promise<T>): Promise<T>;
}

/** Which verifier produced a result (decision 015). */
export type VerifierKind = "command" | "oxlint" | "lemmascript";

/**
 * A check command the operator approved, and the JUnit XML reports it writes,
 * relative to the checkout, from which its failures are compared test by test
 * with the base (decision 040).
 */
export interface ApprovedCheck {
  readonly command: string;
  readonly reports: readonly string[];
  /**
   * The command's related form (decision 052): a command with `{files}`, which Tesota
   * replaces with the candidate's changed files, that runs only the tests
   * related to them. Rounds may run it in place of the command, which still
   * runs before the operator decides.
   */
  readonly related?: Readonly<{ command: string; reports: readonly string[] }> | undefined;
}

/** Where a related form's command takes the changed files. */
export const RELATED_FILES = "{files}";
const relatedPrefix = "related:";

/**
 * A check as the operator types it: the command, then optionally ` => ` and
 * its report paths separated by commas. An `=>` followed by a quote belongs
 * to the command, as in `node -e "x => x"`. A reason instead when a path is
 * not one Tesota reads.
 */
export function parseApprovedCheck(text: string): ApprovedCheck | string {
  const last = text.lastIndexOf("=>");
  const arrow = last >= 0 && /["'`]/u.test(text.slice(last)) ? -1 : last;
  const command = (arrow < 0 ? text : text.slice(0, arrow)).trim();
  if (command.length === 0) return "A check needs a command before =>.";
  if (arrow < 0) return { command, reports: [] };
  const named = text.slice(arrow + 2).split(",").map((path) => path.trim()).filter((path) => path.length > 0);
  if (named.length === 0) return `Name the JUnit XML reports of \`${command}\` after =>, or leave out the =>.`;
  if (named.length > MAX_CHECK_REPORTS) return `A check names at most ${MAX_CHECK_REPORTS} reports.`;
  const reports: string[] = [];
  for (const path of named) {
    const report = normalizeReportPath(path);
    if (report === undefined) return `The report path "${path}" must be relative to the repository, inside it and outside .git.`;
    if (!reports.includes(report)) reports.push(report);
  }
  return { command, reports };
}

/**
 * Checks as the operator types them, separated by `;`: an item that starts
 * with `related:` is the related form of the check before it, and names
 * where the changed files go with `{files}`. A reason instead when one cannot
 * be used.
 */
export function parseApprovedChecks(answer: string): ApprovedCheck[] | string {
  const checks: ApprovedCheck[] = [];
  for (const text of answer.split(";").filter((part) => part.trim().length > 0)) {
    const trimmed = text.trim();
    if (!trimmed.startsWith(relatedPrefix)) {
      const check = parseApprovedCheck(text);
      if (typeof check === "string") return check;
      checks.push(check);
      continue;
    }
    const previous = checks.at(-1);
    if (previous === undefined) return "A related: form follows the check it stands for, as `bun run test; related: bunx vitest related --run {files}`.";
    if (previous.related !== undefined) return `\`${previous.command}\` already has a related form.`;
    const related = parseApprovedCheck(trimmed.slice(relatedPrefix.length));
    if (typeof related === "string") return related;
    if (!related.command.includes(RELATED_FILES)) return `A related form names where the changed files go with ${RELATED_FILES}.`;
    checks[checks.length - 1] = { ...previous, related };
  }
  return checks;
}

function checkText(check: Pick<ApprovedCheck, "command" | "reports">): string {
  return check.reports.length === 0 ? check.command : `${check.command} => ${check.reports.join(", ")}`;
}

/** A check as the operator reads and types it. */
export function approvedCheckText(check: ApprovedCheck): string {
  return check.related === undefined ? checkText(check) : `${checkText(check)}; ${relatedPrefix} ${checkText(check.related)}`;
}

/** Paths as one shell word each, for the POSIX shell every environment runs commands in. */
function shellWords(paths: readonly string[]): string {
  return paths.map((path) => `'${path.replaceAll("'", "'\\''")}'`).join(" ");
}

/** A related form's command for these changed files. */
export function relatedCommand(template: string, files: readonly string[]): string {
  return template.replaceAll(RELATED_FILES, shellWords(files));
}

/**
 * What one verifier observed about one exact workspace tree: its outcome, the
 * claim a pass establishes, and what it does not establish.
 */
export interface CheckResult {
  readonly verifier: VerifierKind;
  /** What ran, as the operator reads it: the command, or the verifier and file. */
  readonly command: string;
  readonly claim: string;
  readonly limits: string;
  readonly tree: string;
  /** The provider that ran the check and what it enforced. */
  readonly environment: string;
  readonly guarantees: EnvironmentGuarantees;
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** The end of combined stdout and stderr, as a terminal would show it: without colors or redrawn progress. */
  readonly output: string;
  /** For a command that failed or timed out: how it ended on the candidate's base, and so whose failure it is (decision 039). */
  readonly base?: BaseCheck;
  /** How long this round's base run took; absent when none ran or an earlier round's run was reused. */
  readonly baseDurationMs?: number;
  /** For a related form's run: the full command it stood in for, which still runs before the operator decides. */
  readonly relatedTo?: string;
}

/** One command's run on the candidate's base, in the same environment. */
export interface BaseCheck {
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly origin: CheckOrigin;
  /** Tests in the check's reports that fail with the changes and pass, or have no result, without them (decision 040). */
  readonly introducedTests?: readonly string[];
  /** How the base run's conditions differed from the candidate's run, which leaves the origin unknown (#267). */
  readonly differs?: string;
}

/**
 * Base runs already made, by command, reports, base and environment: the base
 * does not change between correction rounds, so a round does not pay for it
 * again. A failing run keeps the tests its reports named, and whether its
 * folder was a Git repository to the command (`seesRepository`).
 */
export type BaseRuns = Map<string, Pick<BaseCheck, "outcome" | "exitCode"> & { readonly tests?: TestResults;
  readonly repository?: boolean }>;

const testsNamed = 10;

/** Tests by name, as many as a reader takes in at once. */
export function testList(tests: readonly string[]): string {
  const more = tests.length - testsNamed;
  return tests.slice(0, testsNamed).join("; ") + (more > 0 ? `; and ${more} more` : "");
}

/** What the base run says about a failure, as the operator and the reviewers read it. */
export function describeBase(base: BaseCheck): string {
  const ended = `${base.outcome.replace("_", " ")}${base.exitCode === null ? "" : ` (exit ${base.exitCode})`}`;
  const tests = base.introducedTests ?? [];
  if (base.origin === "introduced" && base.outcome !== "passed" && tests.length > 0) {
    return `also ${ended} without these changes, but ${tests.length === 1 ? "this test fails" : `${tests.length} tests fail`} ` +
      `only with them, so the failure comes with them: ${testList(tests)}`;
  }
  if (base.origin === "introduced") return "passes without these changes, so the failure comes with them";
  if (base.origin === "preexisting") return `also ${ended} without these changes, so it does not come from them`;
  if (base.differs !== undefined) {
    return `without these changes: ${ended}, but the two runs differed: ${base.differs}; so whether the failure comes with ` +
      "these changes is unknown";
  }
  return `without these changes: ${ended}, so whether the failure comes with these changes is unknown`;
}

const outputLimit = 8 * 1024;
const defaultTimeoutSeconds = 15 * 60;

function packageRunner(checkout: string): string {
  if (existsSync(join(checkout, "bun.lock")) || existsSync(join(checkout, "bun.lockb"))) return "bun run";
  if (existsSync(join(checkout, "pnpm-lock.yaml"))) return "pnpm run";
  if (existsSync(join(checkout, "yarn.lock"))) return "yarn run";
  return "npm run";
}

/** The package manager's way to run a dependency's own command. */
const packageExec: Readonly<Record<string, string>> = { "bun run": "bunx", "pnpm run": "pnpm exec", "yarn run": "yarn", "npm run": "npx" };

function packageManifest(checkout: string): Readonly<{ scripts: readonly string[]; dependencies: readonly string[] }> {
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8"));
    const keys = (field: string): string[] => {
      const value: unknown = typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, field) : undefined;
      return typeof value === "object" && value !== null ? Object.keys(value) : [];
    };
    return { scripts: keys("scripts"), dependencies: [...keys("dependencies"), ...keys("devDependencies")] };
  } catch { return { scripts: [], dependencies: [] }; }
}

/** A related form for the repository's test runner, when it has one that selects tests by changed files. */
function relatedForm(runner: string, dependencies: readonly string[]): string | undefined {
  const exec = packageExec[runner] ?? "npx";
  if (dependencies.includes("vitest")) return `${exec} vitest related --run --passWithNoTests ${RELATED_FILES}`;
  if (dependencies.includes("jest")) return `${exec} jest --findRelatedTests --passWithNoTests ${RELATED_FILES}`;
  return undefined;
}

/**
 * Commands the repository appears to use for checking itself, as the operator
 * types them. The command that runs the tests comes with a related form when
 * the repository's test runner can select tests by changed files (decision
 * 052). The operator approves or replaces them.
 */
export function suggestChecks(checkout: string): readonly string[] {
  const { scripts, dependencies } = packageManifest(checkout);
  if (scripts.length > 0) {
    const runner = packageRunner(checkout);
    const related = relatedForm(runner, dependencies);
    const withRelated = (command: string): string => related === undefined ? command : `${command}; ${relatedPrefix} ${related}`;
    if (scripts.includes("check")) return [withRelated(`${runner} check`)];
    return ["typecheck", "lint", "test"].filter((name) => scripts.includes(name))
      .map((name) => name === "test" ? withRelated(`${runner} ${name}`) : `${runner} ${name}`);
  }
  if (existsSync(join(checkout, "Cargo.toml"))) return ["cargo test"];
  if (existsSync(join(checkout, "go.mod"))) return ["go test ./..."];
  return [];
}

interface CommandRun {
  readonly outcome: CheckOutcome;
  readonly exitCode: number | null;
  readonly output: string;
}

/** Where one run happens: the checkout's path commands see, and the folder standing in its place, if any. */
interface RunPlace {
  readonly checkout: string;
  readonly directory: string;
  readonly root?: string | undefined;
  readonly hidden: readonly string[];
}

async function runCommand(environment: ExecutionEnvironment, place: RunPlace, command: string, signal: AbortSignal,
  timeoutSeconds: number, unchanged: () => boolean): Promise<CommandRun> {
  let output = "";
  const run = await environment.run(command, { cwd: place.checkout, timeoutSeconds, signal,
    ...place.root === undefined ? {} : { root: place.root }, ...place.hidden.length === 0 ? {} : { hidden: place.hidden },
    onOutput: (chunk) => { output = (output + chunk.toString("utf8")).slice(-outputLimit); } });
  const outcome: CheckOutcome = run.outcome === "exited"
    ? !unchanged() ? "changed_files" : run.exitCode === 0 ? "passed" : "failed"
    : run.outcome;
  return { outcome, exitCode: run.exitCode, output };
}

function failing(outcome: CheckOutcome): boolean { return outcome === "failed" || outcome === "timed_out"; }

/** One approved check's run on the candidate, with the tests its reports named when it failed. */
interface CandidateRun {
  readonly check: ApprovedCheck;
  readonly result: CheckResult;
  readonly tests?: TestResults | undefined;
}

/**
 * Run a check with its reports removed first, since ignored files outlast a
 * switch to the base, and read the reports it wrote when it failed. A report
 * that cannot be removed could be read as this run's, so the check does not
 * start.
 */
async function runReported(environment: ExecutionEnvironment, place: RunPlace, check: ApprovedCheck,
  signal: AbortSignal, timeoutSeconds: number, unchanged: () => boolean): Promise<CommandRun & { tests?: TestResults }> {
  const kept = clearTestReports(place.directory, check.reports);
  if (kept.length > 0) {
    return { outcome: "not_started", exitCode: null, output: `Not run: its report ${kept.join(", ")} could not be ` +
      "removed first, as a directory, a locked file or a path through a link cannot, so an earlier report could be read as this run's." };
  }
  const run = await runCommand(environment, place, check.command, signal, timeoutSeconds, unchanged);
  const tests = failing(run.outcome) ? readTestResults(place.directory, check.reports) : undefined;
  return tests === undefined ? run : { ...run, tests };
}

/** The command that asks whether a place is a Git repository to the commands run there. */
export const REPOSITORY_PROBE = "git rev-parse --is-inside-work-tree";
const repositoryProbeSeconds = 30;

/**
 * Whether commands in this place see a Git repository, asked as Git documents
 * it (`git rev-parse --is-inside-work-tree`) in the environment that runs them.
 * A worktree's or a submodule's `.git` file names a Git directory outside the
 * checkout, which a sandbox that shows only the checkout cannot reach (#267).
 */
async function seesRepository(environment: ExecutionEnvironment, place: RunPlace, signal: AbortSignal): Promise<boolean> {
  const run = await runCommand(environment, place, REPOSITORY_PROBE, signal, repositoryProbeSeconds, () => true);
  return run.outcome === "passed" && run.output.trim() === "true";
}

/** How a base run's conditions differed from the candidate run's, if they did. */
function conditionsDiffer(candidateRepository: boolean | undefined, baseRepository: boolean | undefined): string | undefined {
  if (candidateRepository === undefined || baseRepository === undefined || candidateRepository === baseRepository) return undefined;
  return candidateRepository
    ? "the folder was a Git repository to the command on this run, not on the run without the changes"
    : "the folder was not a Git repository to the command on this run, as when its .git names a Git directory the " +
      "environment cannot reach, such as a worktree's in a sandbox, while it was one on the run without the changes";
}

/**
 * Run each failing command again on the base, as a commit queue retries a
 * failure without the patch, and record whose failure it is, test by test
 * when the check names reports. The base is checked out only once, for all
 * of them, and only if a run is not known yet. Both places are asked whether
 * they are a Git repository, so a failure is never blamed on the changes when
 * only the two runs' conditions differed (#267).
 */
async function attributeFailures(environment: ExecutionEnvironment, target: CheckTarget, snapshot: WorkspaceSnapshot,
  runs: readonly CandidateRun[], signal: AbortSignal, timeoutSeconds: number, baseRuns: BaseRuns,
  candidate: RunPlace): Promise<CheckResult[]> {
  const key = (check: ApprovedCheck): string => JSON.stringify([environment.provider, snapshot.base, check.command, check.reports]);
  const missing = runs.filter((run) => failing(run.result.outcome) && !baseRuns.has(key(run.check)));
  // An environment that cannot show another folder at the checkout's path leaves the base unknown, never guessed.
  const reachable = !target.basesInOtherFolder || environment.runsInOtherFolders === true;
  const ranMs = new Map<string, number>();
  const candidateRepository = runs.some((run) => failing(run.result.outcome)) && !signal.aborted
    ? await seesRepository(environment, candidate, signal) : undefined;
  if (missing.length > 0 && !signal.aborted && reachable) {
    await target.atBase(snapshot, async (base) => {
      const place: RunPlace = { checkout: target.checkout, directory: base.directory, root: base.root, hidden: candidate.hidden };
      const repository = await seesRepository(environment, place, signal);
      for (const { check } of missing) {
        if (signal.aborted) return;
        const started = Date.now();
        const run = await runReported(environment, place, check, signal, timeoutSeconds, () => base.intact());
        ranMs.set(key(check), Date.now() - started);
        // The base's reports would read as the candidate's to the agent; the next run removes any left.
        clearTestReports(base.directory, check.reports);
        // A cancelled or unconfirmed run says nothing about the base, so it is not remembered.
        if (run.outcome !== "cancelled" && run.outcome !== "unconfirmed") {
          baseRuns.set(key(check), { outcome: run.outcome, exitCode: run.exitCode, repository,
            ...run.tests === undefined ? {} : { tests: run.tests } });
        }
        // Later commands would run on a changed base; they stay unknown.
        if (run.outcome === "changed_files") return;
      }
    });
  }
  return runs.map(({ check, result, tests }) => {
    if (!failing(result.outcome)) return result;
    const base = baseRuns.get(key(check)) ?? { outcome: "not_started" as const, exitCode: null };
    const introduced = introducedTests(tests, base.tests);
    const ran = ranMs.get(key(check));
    const differs = conditionsDiffer(candidateRepository, base.repository);
    return { ...result, base: { outcome: base.outcome, exitCode: base.exitCode,
      origin: checkOrigin(result.outcome, base.outcome, introduced.length, differs === undefined),
      ...introduced.length === 0 ? {} : { introducedTests: introduced }, ...differs === undefined ? {} : { differs } },
      ...ran === undefined ? {} : { baseDurationMs: ran } };
  });
}

export interface CheckOptions {
  readonly timeoutSeconds?: number;
  /** Files hidden from the check's commands, relative with forward slashes, as from the agent's. */
  readonly hidden?: readonly string[];
  /** Hidden files the operator let the checks read, which each result states. */
  readonly readsHidden?: readonly string[];
  /** Base runs to reuse and extend; without it, each call runs the base afresh. */
  readonly baseRuns?: BaseRuns;
  /** The candidate's changed files, given when checks with a related form run that form for them instead. */
  readonly relatedFiles?: readonly string[];
}

/**
 * Run each approved command in the session's environment against the reviewed
 * snapshot, and record which environment produced the result. A check that
 * changes tracked or new files no longer describes that snapshot. A command
 * that fails or times out runs again on the snapshot's base (decision 039),
 * and its reports are compared test by test (decision 040). A check whose
 * report Git does not ignore does not run, since writing the report would
 * change the reviewed files.
 */
export async function runChecks(environment: ExecutionEnvironment, target: CheckTarget, snapshot: WorkspaceSnapshot,
  checks: readonly ApprovedCheck[], signal: AbortSignal, options: CheckOptions = {}): Promise<readonly CheckResult[]> {
  const timeoutSeconds = options.timeoutSeconds ?? defaultTimeoutSeconds;
  const hidden = options.hidden ?? [];
  const place: RunPlace = { checkout: target.checkout, directory: target.checkout, hidden };
  const runs: CandidateRun[] = [];
  for (const check of checks) {
    const files = options.relatedFiles;
    // A related form runs in the command's place; a failure is still judged against the command's own run on the base.
    const ran = check.related === undefined || files === undefined ? check
      : { command: relatedCommand(check.related.command, files), reports: check.related.reports };
    const { command } = ran;
    const read = options.readsHidden ?? [];
    const hiddenRead = read.length === 0 ? "" : ` It could read hidden files the operator allowed: ${read.join(", ")}.`;
    const described = { verifier: "command" as const, command, tree: snapshot.tree, environment: environment.provider,
      guarantees: environment.guarantees, ...ran === check
        ? { claim: `\`${command}\` exits with code 0 on this tree`, limits: `Establishes only what the command itself tests.${hiddenRead}` }
        : { relatedTo: check.command, claim: `The tests \`${check.command}\` relates to the ${files?.length ?? 0} changed ` +
            "files pass on this tree", limits: `Runs only the tests its related form selects; \`${check.command}\` itself runs ` +
            `before you decide.${hiddenRead}` } };
    const tracked = ran.reports.filter((path) => !target.ignores(path));
    if (tracked.length > 0) {
      runs.push({ check, result: { ...described, outcome: "not_started", exitCode: null, durationMs: 0,
        output: `Not run: Git does not ignore its report ${tracked.join(", ")}, so writing it would change the reviewed files.` } });
      continue;
    }
    const started = Date.now();
    const run = await runReported(environment, place, ran, signal, timeoutSeconds,
      () => target.currentTree() === snapshot.tree);
    runs.push({ check, tests: run.tests, result: { ...described, outcome: run.outcome, exitCode: run.exitCode,
      durationMs: Date.now() - started, output: terminalOutputText(run.output) } });
    if (run.outcome === "cancelled" || run.outcome === "unconfirmed" || run.outcome === "changed_files") break;
  }
  return attributeFailures(environment, target, snapshot, runs, signal, timeoutSeconds, options.baseRuns ?? new Map(), place);
}
