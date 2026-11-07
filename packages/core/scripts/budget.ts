import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withinBudget, withinBudgetAfterRetry } from "../src/budget-rule.ts";
import { build } from "./build.ts";

/**
 * Performance budgets, checked on every pull request like fx's. The engine
 * is compiled as a release builds it (`build.ts`), and so is the base the
 * change is measured against (`--base`, by default where the branch left
 * `origin/dev`), with the base's own build script. Both are then measured in
 * alternating rounds on the same machine: `--version` started repeatedly,
 * the scripted loop run (`--measure-loop`, 50 rounds of write and read, with
 * its request's base and its syncs to the disk timed apart), a session of
 * about 1,000 entries resumed (`--measure-resume`), and the shell's first
 * frame drawn (`--measure-shell`).
 *
 * Each timed measurement in `versusBase` fails when the change's median is
 * more than that many times the base's: a slow runner slows both, so their
 * ratio stays put while either one alone moves. Every measurement in
 * `limits` also keeps an absolute limit: exact ones such as the binary's
 * size and the syncs, and loose backstops on the times, so slowdowns too
 * small to fail one change can't add up unnoticed. A failed check is
 * measured again, both binaries, and fails only when both attempts fail.
 * `--report` prints everything without failing, to set or revise a limit.
 */

export interface Measurements {
  readonly startupMs: number;
  readonly binaryBytes: number;
  readonly loopMs: number;
  readonly loopRssBytes: number;
  readonly baseMs: number;
  readonly syncMs: number;
  readonly syncCount: number;
  readonly settleMs: number;
  readonly resumeMs: number;
  readonly firstFrameMs: number;
  readonly shellRssBytes: number;
  readonly sessionBytes: number;
}
export type Limits = { readonly [Name in keyof Measurements]?: number | null };
/**
 * A ratio the owner approved for one comparison only: one measurement of a
 * change at one version against one exact base commit. Each exception names
 * the issue that removes it.
 */
export interface BaseException {
  readonly measurement: keyof Measurements;
  readonly ratio: number;
  readonly base: string;
  readonly version: string;
  readonly reason: string;
  readonly approved: string;
  readonly issue: string;
}
/** A platform's budget: absolute limits, and how many times the base's median each timed measurement may take. */
export interface Budget {
  readonly limits: Limits;
  readonly versusBase: Limits;
  readonly exceptions?: readonly BaseException[];
}
/** Both binaries' measurements from one attempt. */
export interface Attempt {
  readonly change: Measurements;
  readonly base: Measurements;
}

const warmups = 3;
const rounds = 7;
const startsPerRound = 3;

/** The middle value, the statistic least moved by a slow outlier on a shared CI runner. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("No samples to take a median of.");
  return middle;
}

/** Each measurement over its limit, or listed with no limit set yet, described for the check's output. */
export function overBudget(measured: Measurements, limits: Limits, retry?: Measurements): string[] {
  return (Object.keys(limits) as (keyof Measurements)[]).flatMap((name) => {
    const limit = limits[name];
    if (limit === undefined) return [];
    if (limit === null) return [`${name}: no limit set (measured ${measured[name]})`];
    if (retry !== undefined) {
      return withinBudgetAfterRetry(measured[name], retry[name], limit) ? []
        : [`${name}: ${measured[name]} then ${retry[name]} is over its limit of ${limit}`];
    }
    return withinBudget(measured[name], limit) ? [] : [`${name}: ${measured[name]} is over its limit of ${limit}`];
  });
}

/** How many times the base's value the change's is, to the hundredth. */
export function ratio(change: number, base: number): number {
  return Math.round(change / base * 100) / 100;
}

/** Each timed measurement more than its limit times the base's, in this attempt and the retry if there is one. */
export function slowerThanBase(attempt: Attempt, limits: Limits, retry?: Attempt): string[] {
  const ratios = (of: Attempt) => Object.fromEntries((Object.keys(limits) as (keyof Measurements)[])
    .map((name) => [name, ratio(of.change[name], of.base[name])])) as unknown as Measurements;
  const describe = (of: Attempt, name: keyof Measurements) => `${of.change[name]} against the base's ${of.base[name]}`;
  return overBudget(ratios(attempt), limits, retry === undefined ? undefined : ratios(retry)).map((line) => {
    const name = line.slice(0, line.indexOf(":")) as keyof Measurements;
    return `${line} times the base (${describe(attempt, name)}${retry === undefined ? "" : `, then ${describe(retry, name)}`})`;
  });
}

/**
 * The ratios a change at `version` is held to against the commit `base`
 * (a full SHA): the usual ones, with each exception approved for exactly
 * that version and base in place of its measurement's usual ratio.
 */
export function versusBaseFor(budget: Budget, base: string, version: string): { limits: Limits; applied: BaseException[] } {
  const applied = (budget.exceptions ?? []).filter((exception) => exception.base === base
    && exception.version === version && budget.versusBase[exception.measurement] !== undefined);
  const replaced = Object.fromEntries(applied.map((exception) => [exception.measurement, exception.ratio]));
  return { limits: { ...budget.versusBase, ...replaced }, applied };
}

/** How the check's output states each exception it applied, and each measurement over its usual ratio that only an exception allows. */
export function exceptionLines(applied: readonly BaseException[], usual: Limits, overUsual: readonly string[]): string[] {
  const named = new Set<string>(applied.map((exception) => exception.measurement));
  return [
    ...applied.map((exception) => `Exception applied: ${exception.measurement} may be ${exception.ratio} times the base `
      + `instead of ${usual[exception.measurement]}, for ${exception.version} against ${exception.base}. ${exception.reason} `
      + `Approved ${exception.approved}; removed by ${exception.issue}.`),
    ...overUsual.filter((line) => named.has(line.slice(0, line.indexOf(":"))))
      .map((line) => `Over the usual budget, allowed only by the exception: ${line}`),
  ];
}

function started(binary: string, argument: string): string {
  const result = Bun.spawnSync([binary, argument], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${binary} ${argument} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

interface Samples {
  readonly starts: number[];
  readonly loops: { loopMs: number; baseMs: number; syncMs: number; syncCount: number; settleMs: number; loopRssBytes: number }[];
  readonly resumes: { resumeMs: number; sessionBytes: number }[];
  readonly shells: { firstFrameMs: number; shellRssBytes: number }[];
}

function sampleOnce(binary: string, into: Samples): void {
  for (let start = 0; start < startsPerRound; start++) {
    const begun = performance.now();
    started(binary, "--version");
    into.starts.push(performance.now() - begun);
  }
  into.loops.push(JSON.parse(started(binary, "--measure-loop")));
  into.resumes.push(JSON.parse(started(binary, "--measure-resume")));
  into.shells.push(JSON.parse(started(binary, "--measure-shell")));
}

function summarized(binary: string, samples: Samples): Measurements {
  const { starts, loops, resumes, shells } = samples;
  return {
    startupMs: Math.round(median(starts) * 10) / 10,
    binaryBytes: statSync(binary).size,
    loopMs: median(loops.map((loop) => loop.loopMs)),
    loopRssBytes: Math.max(...loops.map((loop) => loop.loopRssBytes)),
    baseMs: median(loops.map((loop) => loop.baseMs)),
    syncMs: median(loops.map((loop) => loop.syncMs)),
    syncCount: Math.max(...loops.map((loop) => loop.syncCount)),
    settleMs: median(loops.map((loop) => loop.settleMs)),
    resumeMs: median(resumes.map((resume) => resume.resumeMs)),
    sessionBytes: Math.max(...resumes.map((resume) => resume.sessionBytes)),
    firstFrameMs: median(shells.map((shell) => shell.firstFrameMs)),
    // The median, not the largest: one run's memory varies by about 13 MB, and a regression moves every run.
    shellRssBytes: median(shells.map((shell) => shell.shellRssBytes)),
  };
}

/** One attempt: both binaries warmed up, then measured in rounds whose order alternates, so neither always goes first. */
export function measure(change: string, base: string): Attempt {
  for (let run = 0; run < warmups; run++) { started(change, "--version"); started(base, "--version"); }
  const samples = { change: { starts: [], loops: [], resumes: [], shells: [] } as Samples,
    base: { starts: [], loops: [], resumes: [], shells: [] } as Samples };
  for (let round = 0; round < rounds; round++) {
    const order = round % 2 === 0 ? (["change", "base"] as const) : (["base", "change"] as const);
    for (const side of order) sampleOnce(side === "change" ? change : base, samples[side]);
  }
  return { change: summarized(change, samples.change), base: summarized(base, samples.base) };
}

const repository = join(import.meta.dir, "..", "..", "..");

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

const same = (a: string, b: string) => existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

/**
 * The base's binary, compiled by the base's own `build.ts` in a worktree of
 * `revision`. The base borrows this checkout's installed packages and
 * ripgrep when its lockfile and ripgrep pin are the same, and installs its
 * own otherwise. The links are removed before the worktree, never what they
 * point to.
 */
function buildBase(revision: string, outfile: string, folder: string): void {
  const tree = join(folder, "base");
  git(["worktree", "add", "--detach", tree, revision]);
  const links: string[] = [];
  const link = (from: string, to: string) => { symlinkSync(from, to, "junction"); links.push(to); };
  try {
    if (same(join(repository, "bun.lock"), join(tree, "bun.lock"))) {
      link(join(repository, "node_modules"), join(tree, "node_modules"));
      if (existsSync(join(repository, "packages", "core", "node_modules"))) {
        link(join(repository, "packages", "core", "node_modules"), join(tree, "packages", "core", "node_modules"));
      }
    } else {
      const install = Bun.spawnSync(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], { cwd: tree, stdout: "ignore", stderr: "pipe" });
      if (install.exitCode !== 0) throw new Error(`The base's bun install failed:\n${install.stderr.toString()}`);
    }
    const pin = join("packages", "core", "src", "ripgrep.ts");
    if (same(join(repository, pin), join(tree, pin))) link(join(repository, "vendor"), join(tree, "vendor"));
    else {
      const vendor = Bun.spawnSync(["bun", "run", "vendor"], { cwd: tree, stdout: "ignore", stderr: "pipe" });
      if (vendor.exitCode !== 0) throw new Error(`The base's ripgrep could not be fetched:\n${vendor.stderr.toString()}`);
    }
    const script = `import { build } from ${JSON.stringify(join(tree, "packages", "core", "scripts", "build.ts"))}; build(${JSON.stringify(outfile)});`;
    const built = Bun.spawnSync(["bun", "-e", script], { cwd: tree, stdout: "ignore", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`The base ${revision} did not build:\n${built.stderr.toString()}`);
  } finally {
    for (const path of links) unlinkSync(path);
    // A base that installs its own packages has paths past Windows' 260 characters under the temporary folder.
    git(["-c", "core.longpaths=true", "worktree", "remove", "--force", tree]);
  }
}

function printReport(attempt: Attempt, versusBase: Limits): void {
  const line = (of: Measurements) => `startup ${of.startupMs} ms, binary ${of.binaryBytes} bytes, loop ${of.loopMs} ms, `
    + `loop memory ${of.loopRssBytes} bytes, base ${of.baseMs} ms, sync ${of.syncMs} ms, syncs ${of.syncCount}, settle ${of.settleMs} ms, `
    + `resume ${of.resumeMs} ms, session ${of.sessionBytes} bytes, first frame ${of.firstFrameMs} ms, shell memory ${of.shellRssBytes} bytes`;
  console.log(`Budget on ${process.platform}, medians of ${rounds} alternating rounds (startup of ${rounds * startsPerRound}):`);
  console.log(`  change: ${line(attempt.change)}`);
  console.log(`  base:   ${line(attempt.base)}`);
  const names = Object.keys(versusBase) as (keyof Measurements)[];
  console.log(`  change/base: ${names.map((name) => `${name} ${ratio(attempt.change[name], attempt.base[name])}`).join(", ")}`);
}

function failures(budget: Budget, versusBase: Limits, attempt: Attempt, retry?: Attempt): string[] {
  return [...overBudget(attempt.change, budget.limits, retry?.change), ...slowerThanBase(attempt, versusBase, retry)];
}

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const given = process.argv.indexOf("--base");
  const revision = given === -1 ? git(["merge-base", "HEAD", "origin/dev"]) : process.argv[given + 1];
  if (revision === undefined || revision === "") throw new Error("Usage: bun scripts/budget.ts [--report] [--base <revision>]");
  const budgets = JSON.parse(readFileSync(join(import.meta.dir, "..", "budgets.json"), "utf8")) as Record<string, Budget | undefined>;
  const budget = budgets[process.platform];
  const folder = mkdtempSync(join(tmpdir(), "tesota-core-budget-"));
  try {
    const change = join(folder, process.platform === "win32" ? "tesota-core.exe" : "tesota-core");
    const base = join(folder, process.platform === "win32" ? "tesota-base.exe" : "tesota-base");
    build(change);
    buildBase(revision, base, folder);
    console.log(`Measuring this checkout against the base ${git(["rev-parse", "--short", revision])}.`);
    const versusBase = budget?.versusBase ?? {};
    const first = measure(change, base);
    printReport(first, versusBase);
    if (budget === undefined) {
      console.log(`No budgets for ${process.platform}; CI checks Linux and Windows.`);
    } else {
      const { version } = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string };
      const { limits, applied } = versusBaseFor(budget, git(["rev-parse", `${revision}^{commit}`]), version);
      let retry: Attempt | undefined;
      let over = failures(budget, limits, first);
      if (over.length > 0 && !report) {
        console.log("Budget exceeded; measuring both binaries again before deciding.");
        retry = measure(change, base);
        printReport(retry, versusBase);
        over = failures(budget, limits, first, retry);
      }
      const prefix = process.env["GITHUB_ACTIONS"] === "true" ? "::warning::" : "";
      for (const line of exceptionLines(applied, versusBase, slowerThanBase(first, versusBase, retry))) console.log(`${prefix}${line}`);
      for (const line of over) console.error(`Over budget: ${line}`);
      if (over.length > 0 && !report) process.exitCode = 1;
    }
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}
