import { expect, it } from "vitest";
import { candidateLines, numberedDiff } from "../src/diff-lines.js";
import { attributeOrigins } from "../src/finding-origin.js";
import { checkedOrigin } from "../src/verification/finding-origin-rule.js";
import type { Finding, ReviewReport } from "../src/review.js";

const header = (path: string): string[] => [`diff --git a/${path} b/${path}`, "index 1111111..2222222 100644",
  `--- a/${path}`, `+++ b/${path}`];
const candidate = {
  changes: [{ status: "modified", path: "src/price.js" }, { status: "added", path: "src/new.js" },
    { status: "modified", path: "src/tax.js" }, { status: "modified", path: "logo.png" },
    { status: "deleted", path: "src/old.js" }] as const,
  diff: [
    ...header("src/price.js"), "@@ -1,4 +1,5 @@", " export function total(amount) {", "-  return amount;",
    "+  const rate = 0.9;", "+  return amount >= 100 ? amount * rate : amount;", " }", " ",
    `diff --git a/src/new.js b/src/new.js`, "new file mode 100644", "--- /dev/null", "+++ b/src/new.js",
    "@@ -0,0 +1,2 @@", "+export const a = 1;", "+export const b = 2;",
    ...header("src/tax.js"), "@@ -8,5 +8,3 @@", " a", " b", "-c", "-d", " e",
    `diff --git a/logo.png b/logo.png`, "Binary files a/logo.png and b/logo.png differ",
    `diff --git a/src/old.js b/src/old.js`, "deleted file mode 100644", "--- a/src/old.js", "+++ /dev/null",
    "@@ -1 +0,0 @@", "-gone",
  ].join("\n"),
};

const claim = (origin: Finding["origin"], path?: string, line?: number): Finding => ({ severity: "high",
  disposition: "fixable", origin, statement: "A problem.", reason: "Because.",
  ...(path === undefined ? {} : { path }), ...(line === undefined ? {} : { line }) });
const attribute = (finding: Finding): Finding => {
  const [report] = attributeOrigins([{ reviewer: "R", tree: "t", status: "completed", summary: "", findings: [finding] }], candidate);
  if (report?.status !== "completed") throw new Error("expected a completed report");
  const [result] = report.findings;
  if (result === undefined) throw new Error("expected a finding");
  return result;
};

it("reads the lines a candidate added and the lines around what it only removed", () => {
  const lines = candidateLines(candidate);
  const sorted = (path: string): number[] => [...lines.get(path)?.touched ?? []].toSorted((a, b) => a - b);
  // A replaced line counts as its replacement; only a pure removal marks the lines around it.
  expect(sorted("src/price.js")).toEqual([2, 3]);
  expect(sorted("src/tax.js")).toEqual([9, 10]);
  expect(lines.get("src/new.js")?.status).toBe("added");
  expect(lines.get("logo.png")?.readable).toBe(false);
});

it("keeps an introduced finding on a line the change added or next to one it removed", () => {
  expect(attribute(claim("introduced", "src/price.js", 3))).toEqual(claim("introduced", "src/price.js", 3));
  expect(attribute(claim("introduced", "src/tax.js", 10)).origin).toBe("introduced");
  expect(attribute(claim("introduced", "./src\\price.js", 2)).origin).toBe("introduced");
});

it("keeps an introduced finding anywhere in a file the change created or deleted, with or without a line", () => {
  expect(attribute(claim("introduced", "src/new.js")).origin).toBe("introduced");
  expect(attribute(claim("introduced", "src/old.js", 1)).origin).toBe("introduced");
});

it("makes an introduced claim unknown when the change cannot be shown to have caused it", () => {
  const cases: [Finding, string][] = [
    [claim("introduced"), "names no file"],
    [claim("introduced", "src/other.js", 4), "does not touch src/other.js"],
    [claim("introduced", "src/price.js", 5), "line 5 of src/price.js"],
    [claim("introduced", "src/price.js"), "names no line in src/price.js"],
    [claim("introduced", "logo.png", 1), "cannot read what changed in logo.png"],
  ];
  for (const [finding, note] of cases) {
    const result = attribute(finding);
    expect(result.origin).toBe("unknown");
    expect(result.originNote).toContain(note);
  }
});

it("makes a preexisting claim unknown when the change created that line or file", () => {
  expect(attribute(claim("preexisting", "src/price.js", 5))).toEqual(claim("preexisting", "src/price.js", 5));
  expect(attribute(claim("preexisting", "src/other.js", 1)).origin).toBe("preexisting");
  expect(attribute(claim("preexisting", "src/price.js", 3))).toMatchObject({ origin: "unknown",
    originNote: expect.stringContaining("this change added line 3 of src/price.js") as unknown });
  expect(attribute(claim("preexisting", "src/new.js", 1))).toMatchObject({ origin: "unknown",
    originNote: expect.stringContaining("this change created src/new.js") as unknown });
});

it("counts a range as introduced when any of its lines changed, and as preexisting only when none was added", () => {
  expect(attribute({ ...claim("introduced", "src/price.js", 4), endLine: 6 }).origin).toBe("unknown");
  expect(attribute({ ...claim("introduced", "src/price.js", 3), endLine: 6 }).origin).toBe("introduced");
  expect(attribute({ ...claim("preexisting", "src/price.js", 3), endLine: 6 }).origin).toBe("unknown");
});

it("leaves a reviewer's own unknown and unfinished reports alone", () => {
  expect(attribute(claim("unknown", "src/price.js", 3))).toEqual(claim("unknown", "src/price.js", 3));
  const unfinished: ReviewReport = { reviewer: "R", tree: "t", status: "incomplete", reason: "timed out" };
  expect(attributeOrigins([unfinished], candidate)).toEqual([unfinished]);
});

it("numbers each added and unchanged diff line with its line in the candidate", () => {
  expect(numberedDiff(candidate.diff).split("\n").slice(4, 10)).toEqual([
    "@@ -1,4 +1,5 @@", "    1  export function total(amount) {", "      -  return amount;",
    "    2 +  const rate = 0.9;", "    3 +  return amount >= 100 ? amount * rate : amount;", "    4  }"]);
});

it("never turns one origin claim into the other, over every combination of facts", () => {
  const bools = [false, true];
  for (const claim of ["introduced", "preexisting", "unknown"] as const) {
    for (const file of ["none", "untouched", "created", "deleted", "modified"] as const) {
      for (const readable of bools) for (const located of bools) for (const touched of bools) for (const added of bools) {
        expect([claim, "unknown"]).toContain(checkedOrigin(claim, file, readable, located, touched, added));
      }
    }
  }
});
