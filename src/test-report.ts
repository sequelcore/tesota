import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { baseTestStatus, testOrigin } from "./verification/check-origin-rule.js";

/** A test's result in a JUnit XML report. */
export type ReportedStatus = "passed" | "failed" | "skipped";

/**
 * The tests a check's JUnit XML reports name, merged by name
 * (docs/design/verification.md, "Tests"), with the reports each test appears
 * in and the reports that were read.
 */
export interface TestResults {
  readonly tests: ReadonlyMap<string, ReportedStatus>;
  readonly sources: ReadonlyMap<string, readonly string[]>;
  readonly read: ReadonlySet<string>;
}

/** Reports a check may name, and how large one may be. */
export const MAX_CHECK_REPORTS = 10;
const reportLimit = 16 * 1024 * 1024;
const pathLimit = 500;

/**
 * A report path as the operator typed it, made relative with `/`; undefined
 * when it is absolute, empty, leaves the checkout or reaches into `.git`.
 */
export function normalizeReportPath(text: string): string | undefined {
  const path = text.trim().replaceAll("\\", "/");
  if (path.length === 0 || path.length > pathLimit || path.includes("\0")) return undefined;
  if (path.startsWith("/") || /^[A-Za-z]:/u.test(path)) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." ||
    segment.toLowerCase() === ".git")) return undefined;
  return path;
}

// A test named twice counts as failed when either run failed, and as passed only when both passed.
const severity: Readonly<Record<ReportedStatus, number>> = { passed: 0, skipped: 1, failed: 2 };

function record(tests: Map<string, ReportedStatus>, name: string, status: ReportedStatus): void {
  const earlier = tests.get(name);
  if (earlier === undefined || severity[status] > severity[earlier]) tests.set(name, status);
}

const entities: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function unescapeXml(value: string): string | undefined {
  let valid = true;
  const text = value.replace(/&([^;&\s]*);?/gu, (whole, name: string) => {
    if (!whole.endsWith(";")) { valid = false; return ""; }
    const hexadecimal = /^#x([0-9a-f]{1,6})$/iu.exec(name)?.[1];
    const decimal = /^#(\d{1,7})$/u.exec(name)?.[1];
    const point = hexadecimal !== undefined ? Number.parseInt(hexadecimal, 16) : decimal !== undefined ? Number(decimal) : undefined;
    if (point !== undefined) {
      if (point > 0x10ffff) { valid = false; return ""; }
      return String.fromCodePoint(point);
    }
    const named = entities[name];
    if (named === undefined) valid = false;
    return named ?? "";
  });
  return valid ? text : undefined;
}

function attributes(text: string): Map<string, string> | undefined {
  const found = new Map<string, string>();
  for (const match of text.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    const value = unescapeXml(match[2] ?? match[3] ?? "");
    if (value === undefined || match[1] === undefined) return undefined;
    found.set(match[1], value);
  }
  return found;
}

/** Where a comment, instruction or character data that starts at `start` ends; -1 when it does not. */
function skipped(xml: string, start: number): number | undefined {
  for (const [open, close] of [["<?", "?>"], ["<!--", "-->"], ["<![CDATA[", "]]>"]] as const) {
    if (!xml.startsWith(open, start)) continue;
    const end = xml.indexOf(close, start + open.length);
    return end < 0 ? -1 : end + close.length;
  }
  return undefined;
}

interface Reading {
  readonly tests: Map<string, ReportedStatus>;
  readonly open: string[];
  readonly suites: (string | undefined)[];
  testcase: { name: string; status: ReportedStatus } | undefined;
}

function opened(reading: Reading, name: string, attributeText: string): boolean {
  const values = attributes(attributeText);
  if (values === undefined) return false;
  if (reading.open.length === 0 && name !== "testsuites" && name !== "testsuite") return false;
  if (name === "testsuite") reading.suites.push(values.get("name"));
  if (name === "testcase") {
    const test = values.get("name");
    if (reading.testcase !== undefined || test === undefined) return false;
    const group = values.get("classname") ?? reading.suites.findLast((suite) => suite !== undefined) ?? "";
    reading.testcase = { name: group.length === 0 ? test : `${group} > ${test}`, status: "passed" };
  } else if (reading.testcase !== undefined && (name === "failure" || name === "error")) {
    reading.testcase.status = "failed";
  } else if (reading.testcase !== undefined && name === "skipped" && reading.testcase.status === "passed") {
    reading.testcase.status = "skipped";
  }
  return true;
}

function closed(reading: Reading, name: string): boolean {
  if (reading.open.pop() !== name) return false;
  if (name === "testsuite") reading.suites.pop();
  if (name === "testcase" && reading.testcase !== undefined) {
    record(reading.tests, reading.testcase.name, reading.testcase.status);
    reading.testcase = undefined;
  }
  return true;
}

const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/uy;

/**
 * The tests of one JUnit XML report: a test is failed when it has a
 * `failure` or `error`, skipped when it has `skipped`, and passed otherwise.
 * Undefined when the text is not a well-formed report, or declares a
 * document type, so that nothing is read from what could not be read whole.
 */
export function parseJUnitReport(xml: string): Map<string, ReportedStatus> | undefined {
  const reading: Reading = { tests: new Map(), open: [], suites: [], testcase: undefined };
  let position = 0;
  let root = false;
  for (;;) {
    const start = xml.indexOf("<", position);
    if (start < 0) break;
    const skip = skipped(xml, start);
    if (skip === -1) return undefined;
    if (skip !== undefined) { position = skip; continue; }
    tagPattern.lastIndex = start;
    const match = tagPattern.exec(xml);
    if (match === null) return undefined;
    const [whole, closing, name = "", attributeText = "", selfClosing] = match;
    position = start + whole.length;
    if (closing === "/") {
      if (attributeText.length > 0 || selfClosing === "/" || !closed(reading, name)) return undefined;
      continue;
    }
    if (reading.open.length === 0 && root) return undefined;
    if (!opened(reading, name, attributeText)) return undefined;
    root = true;
    reading.open.push(name);
    if (selfClosing === "/" && !closed(reading, name)) return undefined;
  }
  return root && reading.open.length === 0 ? reading.tests : undefined;
}

/**
 * Whether a report path stays inside the checkout on this computer: no part of
 * it that exists is a symbolic link or junction, which a command could have
 * pointed at files outside the checkout.
 */
function confined(checkout: string, path: string): boolean {
  let current = checkout;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
    }
  }
  return true;
}

function readReport(checkout: string, path: string): Map<string, ReportedStatus> | undefined {
  try {
    const file = join(checkout, path);
    if (!confined(checkout, path)) return undefined;
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.size > reportLimit) return undefined;
    return parseJUnitReport(readFileSync(file, "utf8"));
  } catch { return undefined; }
}

/**
 * Read and merge the reports a check names, after it ran; undefined when none
 * could be read, as when the command stopped before writing any.
 */
export function readTestResults(checkout: string, paths: readonly string[]): TestResults | undefined {
  const tests = new Map<string, ReportedStatus>();
  const sources = new Map<string, string[]>();
  const read = new Set<string>();
  for (const path of paths) {
    const report = readReport(checkout, path);
    if (report === undefined) continue;
    read.add(path);
    for (const [name, status] of report) {
      record(tests, name, status);
      sources.set(name, [...sources.get(name) ?? [], path]);
    }
  }
  return read.size === 0 ? undefined : { tests, sources, read };
}

/**
 * Remove a check's reports, so that what is read after a run was written by
 * that run; the paths that could not be removed, such as a directory, a locked
 * file or a path through a link, after which the check must not run.
 */
export function clearTestReports(checkout: string, paths: readonly string[]): string[] {
  const kept: string[] = [];
  for (const path of paths) {
    try {
      if (!confined(checkout, path)) throw new Error("The report path passes through a link");
      rmSync(join(checkout, path), { force: true });
    } catch { kept.push(path); }
  }
  return kept;
}

/**
 * The tests that fail with the changes and pass, or have no result, without
 * them (`testOrigin`), by name. A test has no result on the base only when the
 * base's run wrote a report the candidate named it in (`baseTestStatus`).
 */
export function introducedTests(candidate: TestResults | undefined, base: TestResults | undefined): string[] {
  if (candidate === undefined) return [];
  return [...candidate.tests].filter(([name, status]) => {
    const covered = base !== undefined && (candidate.sources.get(name) ?? []).some((path) => base.read.has(path));
    return testOrigin(status, baseTestStatus(base?.tests.get(name) ?? "none", covered)) === "introduced";
  }).map(([name]) => name).sort();
}
