import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withinBudget } from "../src/budget-rule.ts";
import { build } from "./build.ts";

/**
 * Performance budgets (#433, #435, #437), checked on every pull request
 * like fx's: the engine is compiled as a release builds it (`build.ts`), its
 * `--version` started repeatedly, its scripted loop run (`--measure-loop`,
 * 50 rounds of write and read, with its request's base and its syncs to the
 * disk timed apart), and a session of about 1,000 entries resumed
 * (`--measure-resume`). The median startup, the binary's size, the loop's
 * median time and its largest resident memory, the median base and sync,
 * the largest number of syncs, the median settlement, the median resume and the largest session
 * file are compared with the limits in `budgets.json` for this platform; a measurement without a limit there is reported only.
 * `--report` prints them all without failing, to set or revise a limit.
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

const warmups = 3;
const samples = 21;
const loopRuns = 5;

/** The middle value, the statistic least moved by a slow outlier on a shared CI runner. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("No samples to take a median of.");
  return middle;
}

/** Each measurement over its limit, or listed with no limit set yet, described for the check's output. */
export function overBudget(measured: Measurements, limits: Limits): string[] {
  return (Object.keys(limits) as (keyof Measurements)[]).flatMap((name) => {
    const limit = limits[name];
    if (limit === undefined) return [];
    if (limit === null) return [`${name}: no limit set (measured ${measured[name]})`];
    return withinBudget(measured[name], limit) ? [] : [`${name}: ${measured[name]} is over its limit of ${limit}`];
  });
}

function started(binary: string, argument: string): string {
  const result = Bun.spawnSync([binary, argument], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${binary} ${argument} failed:\n${result.stderr.toString()}`);
  return result.stdout.toString();
}

function measure(): Measurements {
  const folder = mkdtempSync(join(tmpdir(), "tesota-core-budget-"));
  try {
    const binary = join(folder, process.platform === "win32" ? "tesota-core.exe" : "tesota-core");
    build(binary);
    const times: number[] = [];
    for (let run = 0; run < warmups + samples; run++) {
      const begun = performance.now();
      started(binary, "--version");
      if (run >= warmups) times.push(performance.now() - begun);
    }
    const loops = Array.from({ length: loopRuns }, () =>
      JSON.parse(started(binary, "--measure-loop")) as { loopMs: number; baseMs: number; syncMs: number; syncCount: number; settleMs: number; loopRssBytes: number });
    const resumes = Array.from({ length: loopRuns }, () =>
      JSON.parse(started(binary, "--measure-resume")) as { resumeMs: number; sessionBytes: number });
    const shells = Array.from({ length: loopRuns }, () =>
      JSON.parse(started(binary, "--measure-shell")) as { firstFrameMs: number; shellRssBytes: number });
    return {
      startupMs: Math.round(median(times) * 10) / 10,
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
      shellRssBytes: Math.max(...shells.map((shell) => shell.shellRssBytes)),
    };
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const budgets = JSON.parse(readFileSync(join(import.meta.dir, "..", "budgets.json"), "utf8")) as Record<string, Limits | undefined>;
  const limits = budgets[process.platform];
  const measured = measure();
  console.log(`Budget on ${process.platform}: startup ${measured.startupMs} ms (median of ${samples}), binary ${measured.binaryBytes} bytes, `
    + `loop ${measured.loopMs} ms (median of ${loopRuns}), loop memory ${measured.loopRssBytes} bytes, `
    + `base ${measured.baseMs} ms (median of ${loopRuns}), sync ${measured.syncMs} ms (median), syncs ${measured.syncCount}, settle ${measured.settleMs} ms (median of ${loopRuns}), `
    + `resume ${measured.resumeMs} ms (median of ${loopRuns}), session ${measured.sessionBytes} bytes, `
    + `first frame ${measured.firstFrameMs} ms (median of ${loopRuns}), shell memory ${measured.shellRssBytes} bytes`);
  if (limits === undefined) {
    console.log(`No budgets for ${process.platform}; CI checks Linux and Windows.`);
  } else {
    const over = overBudget(measured, limits);
    for (const line of over) console.error(`Over budget: ${line}`);
    if (over.length > 0 && !report) process.exitCode = 1;
  }
}
