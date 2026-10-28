import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const main = join(import.meta.dir, "..", "src", "main.ts");

for (const flag of ["--help", "-h"]) {
  test(`${flag} prints the command help and exits successfully`, () => {
    const result = spawnSync(process.execPath, [main, flag], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("A coding agent that checks its code, challenges its specs, and flags where they may miss your request.");
    for (const command of ["tesota -p", "--resume", "--model", "tesota receipt", "--owner", "tesota accounts", "tesota graph", "--version"]) {
      expect(result.stdout).toContain(command);
    }
    expect(result.stdout).toContain("https://github.com/sequelcore/tesota/tree/main/docs");
    // Internal entry points run Tesota's own tooling; they are not commands to offer.
    for (const internal of ["__lsc", "__model-view", "--measure"]) expect(result.stdout).not.toContain(internal);
  });
}

test("an unknown argument lists the supported commands, including graph", () => {
  const result = spawnSync(process.execPath, [main, "--unknown"], { encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unknown argument --unknown");
  expect(result.stderr).toContain("tesota graph");
});
