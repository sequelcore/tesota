import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { appendAssurance, decisionEntry, lastOpenReview, reviewEntry, triageEntry } from "../src/assurance-journal.js";
import { HANDOFF_REPLY_LIMIT, handoffBrief, hasHistory, openFindings } from "../src/handoff-brief.js";
import type { Finding, ReviewReport } from "../src/review.js";

const finding = (fields: Partial<Finding>): Finding => ({ severity: "medium", disposition: "fixable", origin: "introduced",
  statement: "The limit is off by one.", reason: "The request says at most five.", standing: "confirmed", ...fields });

it("gives no brief when the session has nothing recorded", () => {
  const empty = { requests: [], changes: [] };
  expect(hasHistory(empty)).toBe(false);
  expect(handoffBrief(empty)).toBeUndefined();
});

it("marks the brief as Tesota's, gives the requests verbatim, the changes, open findings and the last reply", () => {
  const history = { requests: ["Add a limit of five retries.", "Also log each retry."],
    changes: [{ status: "modified" as const, path: "src/retry.ts" }, { status: "added" as const, path: "src/log.ts" }],
    review: { current: true, findings: [{ severity: "medium" as const, statement: "The limit is off by one.", path: "src/retry.ts", line: 12 }] },
    lastReply: "I added the limit and the log." };
  expect(hasHistory(history)).toBe(true);
  const brief = handoffBrief(history) ?? "";
  expect(brief).toMatch(/^Tesota handoff \(not written by the user\)/u);
  expect(brief).toContain("you do not have that conversation");
  expect(brief).toContain("1. Add a limit of five retries.\n2. Also log each retry.");
  expect(brief).toContain("  edit src/retry.ts\n  add src/log.ts");
  expect(brief).toContain("- [medium] src/retry.ts:12: The limit is off by one.");
  expect(brief).toContain("I added the limit and the log.");
  expect(brief).not.toContain("earlier state");
});

it("says when the findings came from an earlier state of the changes", () => {
  const brief = handoffBrief({ requests: ["Fix it."], changes: [],
    review: { current: false, findings: [{ severity: "high", statement: "It crashes." }] } }) ?? "";
  expect(brief).toContain("an earlier state of these changes");
  expect(brief).toContain("- [high] It crashes.");
});

it("keeps the end of a long last reply and says the rest was left out", () => {
  const reply = `${"a".repeat(HANDOFF_REPLY_LIMIT)}THE END`;
  const brief = handoffBrief({ requests: [], changes: [], lastReply: reply }) ?? "";
  expect(brief).toContain("THE END");
  expect(brief).toContain("(its beginning is left out)");
  expect(brief.length).toBeLessThan(HANDOFF_REPLY_LIMIT + 1_000);
});

const { standing: _standing, ...untested } = finding({ statement: "untested" });

it("counts as open only completed reviews' findings that were not refuted and are not duplicates", () => {
  const reports: ReviewReport[] = [
    { reviewer: "r", tree: "t", status: "completed", summary: "", findings: [finding({ statement: "kept" }),
      finding({ statement: "refuted", standing: "refuted" }), finding({ statement: "unsettled", standing: "unsettled" }),
      finding({ statement: "duplicate", duplicateOf: "r: kept" }), untested] },
    { reviewer: "s", tree: "t", status: "incomplete", reason: "stopped" },
  ];
  expect(openFindings(reports).map((entry) => entry.statement)).toEqual(["kept", "unsettled", "untested"]);
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it("reads the last review of the pending changes from the journal, until the operator decided on it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tesota-journal-"));
  roots.push(directory);
  expect(await lastOpenReview(directory)).toBeUndefined();
  const snapshot = (tree: string) => ({ base: "b".repeat(40), tree, diff: "", changes: [] });
  const report = (tree: string, statement: string): ReviewReport =>
    ({ reviewer: "r", tree, status: "completed", summary: "", findings: [finding({ statement, path: "a.ts", line: 3 })] });
  await appendAssurance(directory, reviewEntry(snapshot("1"), [], [], [], [report("1", "first")]));
  await appendAssurance(directory, reviewEntry(snapshot("2"), [], [], [], [report("2", "second")]));
  expect(await lastOpenReview(directory)).toEqual({ tree: "2", reviews: [expect.objectContaining({ status: "completed",
    findings: [expect.objectContaining({ statement: "second", path: "a.ts", line: 3, severity: "medium" })] })] });
  await appendAssurance(directory, triageEntry("2", ["thanks"], "typesafe:jev-1.13.0",
    { decided: true, checkable: false, probability: 0.05, reason: "Jev: 0.05 checkable" }, false, []));
  expect((await lastOpenReview(directory))?.tree).toBe("2");
  await appendAssurance(directory, decisionEntry("2", "application_conflict"));
  expect((await lastOpenReview(directory))?.tree).toBe("2");
  await appendAssurance(directory, decisionEntry("2", "rejected"));
  expect(await lastOpenReview(directory)).toBeUndefined();
});
