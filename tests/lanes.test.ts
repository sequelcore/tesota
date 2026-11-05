import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { lanes } from "./lanes.js";

test("names each test file in at most one lane, and only files that exist", () => {
  const existing = readdirSync(join(import.meta.dirname)).filter((name) => name.endsWith(".test.ts"));
  const listed = [...lanes.pure, ...lanes.formal];
  expect(listed.filter((name) => !existing.includes(name))).toEqual([]);
  expect(listed.filter((name, index) => listed.indexOf(name) !== index)).toEqual([]);
});

test("fails a test in the pure lane that starts a process", async () => {
  const { spawnSync } = await import("node:child_process");
  expect(() => spawnSync("git", ["--version"])).toThrow("started a process with spawnSync");
});
