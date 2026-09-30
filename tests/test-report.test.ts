import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { clearTestReports, introducedTests, normalizeReportPath, parseJUnitReport, readTestResults,
  type ReportedStatus, type TestResults } from "../src/test-report.js";
import { baseTestStatus, checkOrigin, type CheckOutcome, type ReportedTest, testOrigin,
  type TestStatus } from "../src/verification/check-origin-rule.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const outcomes: readonly CheckOutcome[] = ["passed", "failed", "timed_out", "cancelled", "not_started", "unconfirmed", "changed_files"];
const statuses: readonly TestStatus[] = ["passed", "failed", "skipped", "absent", "unread"];

it("makes a test introduced only when it fails with the changes and passes or has no result without them", () => {
  for (const candidate of statuses) {
    for (const base of statuses) {
      const expected = candidate !== "failed" ? "unknown" : base === "passed" || base === "absent" ? "introduced"
        : base === "failed" ? "preexisting" : "unknown";
      expect(testOrigin(candidate, base), `${candidate} on ${base}`).toBe(expected);
    }
  }
});

it("gives a test no result on the base only when the base wrote a report the candidate named it in", () => {
  for (const reported of ["passed", "failed", "skipped", "none"] as readonly ReportedTest[]) {
    for (const covered of [true, false]) {
      const expected = reported !== "none" ? reported : covered ? "absent" : "unread";
      expect(baseTestStatus(reported, covered), `${reported}, covered ${covered}`).toBe(expected);
    }
  }
});

it("lets tests make a failure introduced, never already there, and only against a base that failed too", () => {
  for (const candidate of outcomes) {
    for (const base of outcomes) {
      const failing = candidate === "failed" || candidate === "timed_out";
      const byOutcome = !failing ? "unknown" : base === "passed" ? "introduced" : base === candidate ? "preexisting" : "unknown";
      expect(checkOrigin(candidate, base, 0), `${candidate} on ${base}`).toBe(byOutcome);
      const withTests = failing && (base === "failed" || base === "timed_out") ? "introduced" : byOutcome;
      expect(checkOrigin(candidate, base, 2), `${candidate} on ${base} with tests`).toBe(withTests);
    }
  }
});

const vitest = `<?xml version="1.0" encoding="UTF-8" ?>
<!-- written by a test runner -->
<testsuites name="vitest tests" tests="5" failures="2" errors="0" time="1.2">
  <testsuite name="tests/price.test.ts" timestamp="2026-09-28T00:00:00Z" hostname="h" tests="5" failures="2" errors="0" skipped="1" time="1">
    <testcase classname="tests/price.test.ts" name="discounts &quot;over&quot; $100" time="0.1">
    </testcase>
    <testcase classname="tests/price.test.ts" name="rounds &lt;cents&gt;" time="0.1">
      <failure message="expected 1 &amp; 2 to be &#x3C;3" type="AssertionError"><![CDATA[at price.test.ts:3 <tag> ]]>
AssertionError: expected 1 &amp; 2
      </failure>
    </testcase>
    <testcase classname="tests/price.test.ts" name="listens on loopback" time="0">
      <error message="EACCES"/>
    </testcase>
    <testcase classname="tests/price.test.ts" name="later" time="0"><skipped/></testcase>
    <testcase name="no class" time="0"/>
  </testsuite>
</testsuites>
`;

it("reads a runner's JUnit report: failures, errors, skips, escapes and character data", () => {
  expect(parseJUnitReport(vitest)).toEqual(new Map<string, ReportedStatus>([
    ["tests/price.test.ts > discounts \"over\" $100", "passed"],
    ["tests/price.test.ts > rounds <cents>", "failed"],
    ["tests/price.test.ts > listens on loopback", "failed"],
    ["tests/price.test.ts > later", "skipped"],
    ["tests/price.test.ts > no class", "passed"],
  ]));
  expect(parseJUnitReport('<testsuite name="s"></testsuite>')).toEqual(new Map());
});

it.each([
  ["empty", ""],
  ["not a report", "<html><body/></html>"],
  ["unclosed", '<testsuites><testsuite name="s"><testcase name="a"></testsuite></testsuites>'],
  ["unterminated character data", '<testsuite><testcase name="a"><failure><![CDATA[x</failure></testcase></testsuite>'],
  ["a second root", '<testsuite name="a"/><testsuite name="b"/>'],
  ["a test without a name", '<testsuite><testcase classname="c"/></testsuite>'],
  ["a test inside a test", '<testsuite><testcase name="a"><testcase name="b"/></testcase></testsuite>'],
  ["an unknown entity", '<testsuite><testcase name="a &nbsp; b"/></testsuite>'],
  ["a document type", '<!DOCTYPE x [<!ENTITY e "y">]><testsuite><testcase name="&e;"/></testsuite>'],
  ["a truncated file", '<testsuites><testsuite name="s"><testcase name="a"/>'],
])("reads nothing from a report that is not whole: %s", (_label, xml) => {
  expect(parseJUnitReport(xml)).toBeUndefined();
});

it("counts a test named twice as failed when either run failed, and as passed only when both passed", () => {
  expect(parseJUnitReport(`<testsuite name="s"><testcase name="a"/><testcase name="a"><failure/></testcase>
    <testcase name="b"><skipped/></testcase><testcase name="b"/></testsuite>`))
    .toEqual(new Map([["s > a", "failed"], ["s > b", "skipped"]]));
});

it.each([
  ["test-reports/unit.xml", "test-reports/unit.xml"],
  [" test-reports\\workspace.xml ", "test-reports/workspace.xml"],
  ["../unit.xml", undefined], ["reports/../../unit.xml", undefined], ["/tmp/unit.xml", undefined],
  ["C:\\reports\\unit.xml", undefined], ["\\\\server\\unit.xml", undefined], [".git/unit.xml", undefined],
  ["reports//unit.xml", undefined], ["./unit.xml", undefined], ["", undefined],
])("keeps report paths inside the repository and outside .git: %j", (path, expected) => {
  expect(normalizeReportPath(path)).toBe(expected);
});

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-test-report-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const report = (cases: Record<string, "passed" | "failed">): string => `<testsuite name="s">${Object.entries(cases)
  .map(([name, status]) => `<testcase name="${name}">${status === "failed" ? "<failure/>" : ""}</testcase>`).join("")}</testsuite>`;

it("merges a check's reports, and records where each test came from and which reports were read", () => {
  const root = checkout({ "r/unit.xml": report({ a: "failed" }), "r/workspace.xml": report({ b: "passed", a: "passed" }),
    "r/broken.xml": "<testsuite" });
  expect(readTestResults(root, ["r/unit.xml", "r/workspace.xml"])).toEqual({
    tests: new Map([["s > a", "failed"], ["s > b", "passed"]]),
    sources: new Map([["s > a", ["r/unit.xml", "r/workspace.xml"]], ["s > b", ["r/workspace.xml"]]]),
    read: new Set(["r/unit.xml", "r/workspace.xml"]) });
  expect(readTestResults(root, ["r/unit.xml", "r/missing.xml", "r/broken.xml"])).toEqual({
    tests: new Map([["s > a", "failed"]]), sources: new Map([["s > a", ["r/unit.xml"]]]), read: new Set(["r/unit.xml"]) });
  expect(readTestResults(root, ["r/missing.xml"])).toBeUndefined();
  expect(clearTestReports(root, ["r/unit.xml", "r/missing.xml"])).toEqual([]);
  expect(readTestResults(root, ["r/unit.xml"])).toBeUndefined();
});

it("reports what it cannot remove, and neither removes nor reads through a link out of the checkout", () => {
  const outside = checkout({ "unit.xml": report({ a: "failed" }) });
  const root = checkout({ "r/folder.xml/inside.txt": "x" });
  symlinkSync(outside, join(root, "linked"), "junction");
  expect(clearTestReports(root, ["r/folder.xml", "linked/unit.xml", "r/missing.xml"])).toEqual(["r/folder.xml", "linked/unit.xml"]);
  expect(existsSync(join(outside, "unit.xml"))).toBe(true);
  expect(existsSync(join(root, "r/folder.xml/inside.txt"))).toBe(true);
  expect(readTestResults(root, ["linked/unit.xml", "r/folder.xml"])).toBeUndefined();
});

it("names the tests that fail only with the changes, judging a test with no base result by its own report", () => {
  const results = (tests: Record<string, ReportedStatus>, read: string[], source = (_name: string) => read): TestResults =>
    ({ tests: new Map(Object.entries(tests)), read: new Set(read),
      sources: new Map(Object.keys(tests).map((name) => [name, source(name)])) });
  const candidate = results({ loopback: "failed", price: "failed", added: "failed", flaky: "failed", fixed: "passed",
    later: "failed" }, ["unit.xml", "workspace.xml"], (name) => [name === "later" ? "workspace.xml" : "unit.xml"]);
  const base = results({ loopback: "failed", price: "passed", flaky: "skipped", fixed: "failed" }, ["unit.xml", "workspace.xml"]);
  expect(introducedTests(candidate, base)).toEqual(["added", "later", "price"]);
  // The base run did not write the report `later` is in, so its absence there says nothing; `added`'s report was read.
  expect(introducedTests(candidate, { ...base, read: new Set(["unit.xml"]) })).toEqual(["added", "price"]);
  expect(introducedTests(candidate, undefined)).toEqual([]);
  expect(introducedTests(undefined, base)).toEqual([]);
});
