import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readingHash } from "../src/model-chart.js";

/**
 * Trusts a project's chart reading as it is now, as the shell's `/graph` does
 * (#761): through the engine's own trust store, in this test file's home.
 */
export function trustReading(root: string, file: string): void {
  // The store expects Tesota's home to exist, as it does once the shell has run.
  mkdirSync(join(homedir(), ".tesota"), { recursive: true });
  const store = pathToFileURL(resolve("packages/core/src/trust.ts")).href;
  execFileSync("bun", ["-e", `const { chartTrust, trust } = await import(${JSON.stringify(store)});
trust(process.env.READING_ROOT, chartTrust(process.env.READING_FILE), process.env.READING_HASH);`], {
    env: { ...process.env, READING_ROOT: root, READING_FILE: file, READING_HASH: readingHash(readFileSync(join(root, file))) },
  });
}
