import { expect, it } from "vitest";
import { prbenchAnswer, prbenchReviewInput } from "../src/prbench-review.js";
import type { Finding, ReviewReport } from "../src/review.js";

const diff = [
  "diff --git a/pkg/io.py b/pkg/io.py",
  "--- a/pkg/io.py",
  "+++ b/pkg/io.py",
  "@@ -10,2 +10,2 @@",
  "-    return open(path)",
  "+    return open(path, encoding=enc)",
  "diff --git a/pkg/new.py b/pkg/new.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/pkg/new.py",
  "@@ -0,0 +1 @@",
  "+x = 1",
].join("\n");

it("reviews a benchmark task from its official context alone, with the diff's files as the change", () => {
  const input = prbenchReviewInput({ taskId: "dask__12221", context: "## Layer 0 - Task + Focus\nRead files with an encoding.", diff },
    "/tmp/empty");
  expect(input.requests).toEqual(["## Layer 0 - Task + Focus\nRead files with an encoding."]);
  expect(input.checkout).toBe("/tmp/empty");
  expect(input.snapshot).toMatchObject({ tree: "dask__12221", diff,
    changes: [{ status: "modified", path: "pkg/io.py" }, { status: "added", path: "pkg/new.py" }] });
  expect(input.checks).toEqual([]);
  expect(input.flags).toEqual([]);
});

const finding = (overrides: Partial<Finding>): Finding => ({ severity: "high", disposition: "fixable", origin: "introduced",
  statement: "The encoding is ignored.", reason: "enc is never passed on.", path: "pkg/io.py", line: 11, ...overrides });

function unlocated(found: Finding): Finding {
  const { path: _path, line: _line, ...rest } = found;
  return rest;
}

it("answers with what Tesota shows, in the benchmark's format and severities", () => {
  const reports: ReviewReport[] = [
    { reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "", findings: [
      finding({ standing: "confirmed" }),
      finding({ severity: "low", statement: "Name is vague.", reason: "x is unclear.", path: "pkg/new.py", line: 1, standing: "unsettled" }),
      finding({ statement: "Refuted claim.", standing: "refuted" }),
    ] },
    { reviewer: "Tesota reviewer · correctness and regressions", tree: "t", status: "completed", summary: "", findings: [
      unlocated(finding({ severity: "medium", statement: "No test for the encoding.", reason: "Only the default path is tested.",
        standing: "confirmed" })),
      finding({ standing: "confirmed", duplicateOf: "Tesota reviewer: The encoding is ignored." }),
    ] },
  ];
  expect(JSON.parse(prbenchAnswer(reports))).toEqual([
    { body: "The encoding is ignored. enc is never passed on.", file: "pkg/io.py", line: 11, severity: "P0" },
    { body: "Name is vague. x is unclear.", file: "pkg/new.py", line: 1, severity: "P2" },
    { body: "No test for the encoding. Only the default path is tested.", file: null, line: null, severity: "P1" },
  ]);
});

it("never answers an unfinished review as a clean one", () => {
  expect(prbenchAnswer([{ reviewer: "Tesota reviewer", tree: "t", status: "completed", summary: "", findings: [] }])).toBe("[]");
  const unfinished = prbenchAnswer([{ reviewer: "Tesota reviewer", tree: "t", status: "incomplete", reason: "the reviewer ran past its time limit" }]);
  expect(() => { JSON.parse(unfinished); }).toThrow();
  expect(unfinished).toContain("ran past its time limit");
});
