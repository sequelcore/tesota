import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it.each([
  ["repository root", ".", "packages/core/tests/session.test.ts"],
  ["engine folder", "packages/core", "tests/session.test.ts"],
])("a direct session test from the %s refuses before writing home state", (_name, cwd, file) => {
  // Give the child a fresh home, but no wrapper marker: this is the direct
  // invocation that bypassed isolation in #612. Never inspect the real home.
  const home = mkdtempSync(join(tmpdir(), "tesota-direct-test-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  delete env["TESOTA_ISOLATED"];
  try {
    const run = spawnSync("bun", ["test", file, "--test-name-pattern", "a resumed session has its conversation", "--timeout", "30000"], {
      cwd: resolve(import.meta.dirname, "..", cwd), env, encoding: "utf8", timeout: 60_000,
    });
    expect(run.error).toBeUndefined();
    expect(readdirSync(home)).toEqual([]);
    expect(run.status).not.toBe(0);
    expect(run.stdout + run.stderr).toContain("Run the engine's tests with `bun run test`");
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  }
}, 65_000);
