import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { contentHash } from "../src/evidence.js";
import { annotations, proveFile } from "../src/verification/lemmascript-verifier.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dafny = spawnSync("dafny", ["--version"], { encoding: "utf8" }).status === 0;

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-lemmascript-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(root, path), content);
  return root;
}
const prove = (root: string, path: string) => proveFile(root, path, new AbortController().signal);

// The registered "clamp above the maximum" proof case: its base returns `low` above the maximum.
const clampBase = "//@ requires low <= high\n//@ ensures low <= \\result && \\result <= high\n" +
  "//@ ensures low <= value && value <= high ==> \\result === value\n//@ ensures value > high ==> \\result === high\n" +
  "export function clamp(value: number, low: number, high: number): number {\n  if (value < low) return low;\n" +
  "  if (value > high) return low;\n  return value;\n}\n";
const clampFixed = clampBase.replace("if (value > high) return low;", "if (value > high) return high;");

it("reads the properties a LemmaScript file claims", () => {
  expect(annotations("//@ ensures \\result >= 0\nexport function f(): number {\n  //@ invariant i >= 0\n  return 1;\n}")).toEqual(
    ["//@ ensures \\result >= 0", "//@ invariant i >= 0"]);
});

it.runIf(dafny)("refutes the registered clamp base and proves its fix, bound to the source and its proof", async () => {
  const root = project({ "clamp.ts": clampBase });
  const refuted = await prove(root, "clamp.ts");
  expect(refuted).toMatchObject({ verifier: "lemmascript", outcome: "failed", files: ["clamp.ts", "clamp.dfy"] });
  expect(refuted.claim).toContain("//@ ensures value > high ==> \\result === high");
  writeFileSync(join(root, "clamp.ts"), clampFixed);
  const proved = await prove(root, "clamp.ts");
  expect(proved.outcome).toBe("passed");
  expect(proved.output).toMatch(/finished with [1-9]\d* verified, 0 errors/u);
  const read = (path: string) => ({ path, content: readFileSync(join(root, path), "utf8") });
  expect(proved.contentHash).toBe(contentHash([read("clamp.ts"), read("clamp.dfy")]));
  expect(proved.contentHash).not.toBe(refuted.contentHash);
  appendFileSync(join(root, "clamp.dfy"), "\n");
  expect(contentHash([read("clamp.ts"), read("clamp.dfy")])).not.toBe(proved.contentHash);
}, 120_000);

it.runIf(dafny)("never counts a run in which Dafny verified nothing as proved", async () => {
  const root = project({ "loose.ts": "//@ ensures \\result >= 0\nexport const a = 1;\n" });
  const proof = await prove(root, "loose.ts");
  expect(proof.outcome).toBe("not_started");
  expect(proof.output).toContain("LemmaScript verified nothing in this file, so nothing was proved.");
}, 120_000);

it.runIf(dafny)("regenerates an out-of-date proof before checking it, keeping the proof lines added by hand", async () => {
  const root = project({ "clamp.ts": clampFixed });
  expect((await prove(root, "clamp.ts")).outcome).toBe("passed");
  appendFileSync(join(root, "clamp.dfy"), "\nlemma Added()\n  ensures true\n{}\n");
  writeFileSync(join(root, "clamp.ts"), clampFixed.replace("return value;", "return value + 0;"));
  const proof = await prove(root, "clamp.ts");
  expect(proof.outcome).toBe("passed");
  const dfy = readFileSync(join(root, "clamp.dfy"), "utf8");
  expect(dfy).toContain("lemma Added()");
  expect(dfy).toContain("value + 0");
}, 120_000);
