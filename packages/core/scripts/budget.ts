import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withinBudget } from "../src/budget-rule.ts";

/**
 * Performance budgets (#433, #435), checked on every pull request like
 * fx's: the engine is compiled with `bun build --compile`, its `--version`
 * started repeatedly, and its scripted loop run (`--measure-loop`, 50
 * rounds of write and read). The median startup, the binary's size, the
 * loop's median time and its largest resident memory are compared with the
 * limits in `budgets.json` for this platform; a measurement without a limit
 * there is reported only. `--report` prints them all without failing, to
 * set or revise a limit.
 */

export interface Measurements {
  readonly startupMs: number;
  readonly binaryBytes: number;
  readonly loopMs: number;
  readonly loopRssBytes: number;
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
    // Bytecode saves the time JavaScriptCore spends parsing the bundled loop at every start (about 20 ms on Windows, #435).
    const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", "--bytecode", join(import.meta.dir, "..", "src", "main.ts"),
      "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`bun build --compile failed:\n${build.stderr.toString()}`);
    const times: number[] = [];
    for (let run = 0; run < warmups + samples; run++) {
      const begun = performance.now();
      started(binary, "--version");
      if (run >= warmups) times.push(performance.now() - begun);
    }
    const loops = Array.from({ length: loopRuns }, () =>
      JSON.parse(started(binary, "--measure-loop")) as { loopMs: number; loopRssBytes: number });
    return {
      startupMs: Math.round(median(times) * 10) / 10,
      binaryBytes: statSync(binary).size,
      loopMs: median(loops.map((loop) => loop.loopMs)),
      loopRssBytes: Math.max(...loops.map((loop) => loop.loopRssBytes)),
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
    + `loop ${measured.loopMs} ms (median of ${loopRuns}), loop memory ${measured.loopRssBytes} bytes`);
  if (limits === undefined) {
    console.log(`No budgets for ${process.platform}; CI checks Linux and Windows.`);
  } else {
    const over = overBudget(measured, limits);
    for (const line of over) console.error(`Over budget: ${line}`);
    if (over.length > 0 && !report) process.exitCode = 1;
  }
}
