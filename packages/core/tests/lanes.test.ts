import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { lanes } from "./lanes.ts";

test("names each test file in at most one lane, and only files that exist", () => {
  const existing = readdirSync(import.meta.dir).filter((name) => name.endsWith(".test.ts"));
  const listed: string[] = Object.values(lanes).flat();
  expect(listed.filter((name) => !existing.includes(name))).toEqual([]);
  expect(listed.filter((name, index) => listed.indexOf(name) !== index)).toEqual([]);
});
