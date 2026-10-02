import { expect, it } from "vitest";
import { owesWholeCommand, runsRelatedForm } from "../src/verification/check-scope-rule.js";
import { approvedCheckText, parseApprovedChecks, relatedCommand } from "../src/workspace-checks.js";

/**
 * A check's related form (decision 052): typed after the check it stands for,
 * it runs only the tests related to the changed files in a round, and never
 * decides a result alone.
 */

it("reads a related form after the check it stands for, and types it back the same way", () => {
  const typed = "bun run check => test-reports/unit.xml; related: bunx vitest related --run {files} => test-reports/related.xml; bun run lint";
  const checks = parseApprovedChecks(typed);
  expect(checks).toEqual([
    { command: "bun run check", reports: ["test-reports/unit.xml"],
      related: { command: "bunx vitest related --run {files}", reports: ["test-reports/related.xml"] } },
    { command: "bun run lint", reports: [] },
  ]);
  if (typeof checks === "string") throw new Error(checks);
  expect(checks.map(approvedCheckText).join("; ")).toBe(typed);
});

it("refuses a related form with no check before it, a second one, or no place for the files", () => {
  expect(parseApprovedChecks("related: bunx vitest related {files}")).toMatch(/follows the check/u);
  expect(parseApprovedChecks("bun run test; related: a {files}; related: b {files}")).toMatch(/already has a related form/u);
  expect(parseApprovedChecks("bun run test; related: bunx vitest related --run")).toMatch(/\{files\}/u);
});

it("passes each changed file as one shell word, whatever it holds", () => {
  expect(relatedCommand("vitest related --run {files}", ["src/a.ts", "docs/it's here.md"]))
    .toBe("vitest related --run 'src/a.ts' 'docs/it'\\''s here.md'");
});

it("runs a related form only for a round that can still send work back and whose changes it can select by", () => {
  expect(runsRelatedForm(true, true, false, false, false)).toBe(true);
  expect(runsRelatedForm(false, true, false, false, false)).toBe(false);
  expect(runsRelatedForm(true, false, false, false, false)).toBe(false);
  expect(runsRelatedForm(true, true, true, false, false)).toBe(false);
  expect(runsRelatedForm(true, true, false, true, false)).toBe(false);
  expect(runsRelatedForm(true, true, false, false, true)).toBe(false);
  expect(owesWholeCommand(true)).toBe(true);
  expect(owesWholeCommand(false)).toBe(false);
});
