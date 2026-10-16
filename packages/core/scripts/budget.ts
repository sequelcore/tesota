import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withinBudget } from "../src/budget-rule.ts";

/**
 * Performance budgets (#433), checked on every pull request like fx's: the
 * engine is compiled with `bun build --compile`, its `--version` started
 * repeatedly, and the median startup and the binary's size compared with
 * the limits in `budgets.json` for this platform. `--report` prints the
 * measurements without failing, to set or revise a limit.
 */

export interface Measurements { readonly startupMs: number; readonly binaryBytes: number }
export type Limits = { readonly [Name in keyof Measurements]: number | null };

const warmups = 3;
const samples = 21;

/** The middle value, the statistic least moved by a slow outlier on a shared CI runner. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor(sorted.length / 2)];
  if (middle === undefined) throw new Error("No samples to take a median of.");
  return middle;
}

/** Each measurement over its limit, or with no limit set, described for the check's output. */
export function overBudget(measured: Measurements, limits: Limits): string[] {
  return (Object.keys(measured) as (keyof Measurements)[]).flatMap((name) => {
    const limit = limits[name];
    if (limit === null) return [`${name}: no limit set (measured ${measured[name]})`];
    return withinBudget(measured[name], limit) ? [] : [`${name}: ${measured[name]} is over its limit of ${limit}`];
  });
}

function measure(): Measurements {
  const folder = mkdtempSync(join(tmpdir(), "tesota-core-budget-"));
  try {
    const binary = join(folder, process.platform === "win32" ? "tesota-core.exe" : "tesota-core");
    const build = Bun.spawnSync(["bun", "build", "--compile", "--minify", join(import.meta.dir, "..", "src", "main.ts"),
      "--outfile", binary], { stdout: "ignore", stderr: "pipe" });
    if (build.exitCode !== 0) throw new Error(`bun build --compile failed:\n${build.stderr.toString()}`);
    const times: number[] = [];
    for (let run = 0; run < warmups + samples; run++) {
      const started = performance.now();
      const result = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
      const elapsed = performance.now() - started;
      if (result.exitCode !== 0) throw new Error(`${binary} --version failed:\n${result.stderr.toString()}`);
      if (run >= warmups) times.push(elapsed);
    }
    return { startupMs: Math.round(median(times) * 10) / 10, binaryBytes: statSync(binary).size };
  } finally {
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (import.meta.main) {
  const report = process.argv.includes("--report");
  const budgets = JSON.parse(readFileSync(join(import.meta.dir, "..", "budgets.json"), "utf8")) as Record<string, Limits | undefined>;
  const limits = budgets[process.platform];
  const measured = measure();
  console.log(`Budget on ${process.platform}: startup ${measured.startupMs} ms (median of ${samples}), binary ${measured.binaryBytes} bytes`);
  if (limits === undefined) {
    console.log(`No budgets for ${process.platform}; CI checks Linux and Windows.`);
  } else {
    const over = overBudget(measured, limits);
    for (const line of over) console.error(`Over budget: ${line}`);
    if (over.length > 0 && !report) process.exitCode = 1;
  }
}
