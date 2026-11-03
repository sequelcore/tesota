import { expect, it } from "vitest";
import { noEvidence, receiptFindings, receiptStanding, renderReceipt, renderReceiptMessage, type Receipt, unitReceipt } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";
import { receiptMarkdown, receiptStatement } from "../src/pull-request-receipt.js";

it("stores and exports exact stage context and explicit capacity omissions (#627)", () => {
  const context = [{ method: "claimcheck" as const, stage: "comparison" as const, model: "test/reviewer", folder: "app", requests: [
    { run: 1, text: ["Original requirement", "Amendment"] }, { run: 3, text: ["continue"] },
  ], omitted: [2] }];
  const receipt: Receipt = { ...emptyReceipt, requestContext: { requests: [{ run: 1, text: ["Original requirement", "Amendment"] }] },
    requestReview: { ...emptyReceipt.requestReview, context } };
  const stored: Receipt = JSON.parse(JSON.stringify(receipt));
  expect(stored.requestReview.context).toEqual(context);
  const subject = { commit: "abc", owner: "operator", sessionId: "session", stale: [], changedAfter: [] };
  for (const text of [renderReceipt(stored), renderReceiptMessage(stored), receiptMarkdown(stored, subject)]) {
    expect(text).toContain("requests 1 and 3");
    expect(text).toContain("left out request 2: context capacity");
  }
  expect(receiptStatement(stored, subject, "2026-10-26", "COMPLETED"))
    .toMatchObject({ predicate: { custom: { receipt: { requestReview: { context } } } } });
  const openContext = { method: "open_cases" as const, stage: "open_cases" as const, folder: "", requests: [{ run: 3, text: ["continue"] }], omitted: [] };
  const openCases = { status: "not_run" as const, reason: "test/lister: provider unavailable" };
  const workspace: Receipt = { ...stored, requestReview: { ...stored.requestReview, openCases, context: [...context,
    { method: "claimcheck", stage: "comparison", folder: "other", requests: [{ run: 3, text: ["continue"] }], omitted: [1, 2] }, openContext] },
    units: [{ ...emptyReceipt, folder: "app" }] };
  const unit = unitReceipt(workspace, "app");
  expect(unit?.requestReview.context).toEqual([...context, openContext]);
  expect(unit?.requestReview.openCases).toEqual(openCases);
  if (unit === undefined) throw new Error("missing unit");
  expect(receiptMarkdown(unit, subject)).toContain("test/lister: provider unavailable");
  expect(receiptMarkdown(unit, subject)).not.toContain("left out requests 1 and 2");
  expect(renderReceipt(stored)).toMatchSnapshot();
});

it("exports only the selected unit's review status and admitted checks (#731)", () => {
  const receipt: Receipt = { ...emptyReceipt, units: [{ ...emptyReceipt, folder: "app" }],
    codeEvidence: { ...emptyReceipt.codeEvidence, checksAtStart: [{ folder: "app", projects: [] }, { folder: "other", projects: [] }] },
    requestReview: { ...emptyReceipt.requestReview, contractComparison: { scope: "eligible_changed_contracts", status: "partial",
      reason: "other review unavailable", contracts: [{ folder: "app", path: "rule.ts", name: "rule", text: "contract" }],
      runs: [{ folder: "app", status: "completed" }, { folder: "other", status: "not_run", reason: "other review unavailable" }] } } };
  const unit = unitReceipt(receipt, "app");
  expect(unit?.codeEvidence.checksAtStart).toEqual([{ folder: "app", projects: [] }]);
  expect(unit?.requestReview.contractComparison).toMatchObject({ status: "completed", runs: [{ folder: "app", status: "completed" }] });
  expect(unit?.requestReview.contractComparison.reason).toBeUndefined();
});

it("keeps a later unit's assessment visible when an earlier unit's review could not run (#731)", () => {
  const receipt: Receipt = { ...emptyReceipt, units: [{ ...emptyReceipt, folder: "a" }, { ...emptyReceipt, folder: "b" }],
    requestReview: { ...emptyReceipt.requestReview, contractComparison: { scope: "eligible_changed_contracts", status: "partial",
      runs: [{ folder: "a", status: "not_run", reason: "reader unavailable" },
        { folder: "b", status: "completed", restatedBy: "B/reader", comparedBy: "B/comparer" }],
      contracts: [{ folder: "b", path: "rule.ts", name: "rule", text: "contract",
        assessment: { verdict: "mismatch", explanation: "The boundary differs." } }] } } };
  expect(receiptFindings(receipt).filter(({ standing }) => standing === "opinion")).toHaveLength(2);
  for (const text of [renderReceipt(receipt), renderReceiptMessage(receipt)]) {
    expect(text).toContain("b/rule.ts");
    expect(text).toContain("The boundary differs.");
    expect(text).toContain("B/comparer");
    expect(text).toContain("reader unavailable");
  }
});

it("keeps failed mechanical checks visible even within a workspace unit", () => {
  expect(receiptStanding(emptyReceipt)).toBe("unchanged");
  expect(receiptStanding({ ...emptyReceipt, stopped: "the operator stopped the run" })).toBe("incomplete");
  const failing = { command: "npm test", verdict: "send_back" as const, evidence: { verifier: "command" as const, claim: "the tests pass",
    limits: "", outcome: "failed" as const, output: "1 failed", durationMs: 1, files: [], contentHash: "" } };
  expect(receiptStanding({ ...emptyReceipt, codeEvidence: { ...emptyReceipt.codeEvidence, tests: [failing] } })).toBe("failed");
  expect(receiptStanding({ ...emptyReceipt, repository: false, units: [{ ...noEvidence, folder: "app", repository: true, base: null,
    codeEvidence: { ...noEvidence.codeEvidence, tests: [failing] } }] })).toBe("failed");
});

it("keeps unchecked paths inside fenced details, without interpreting Markdown", () => {
  const message = renderReceiptMessage({ ...emptyReceipt, codeEvidence: { ...emptyReceipt.codeEvidence, unverified: ["src/[rule]*.ts"] } });
  expect(message).toContain("No proof covers 1 changed file");
  expect(message).toContain("```text\n  not verified  src/[rule]*.ts: no verifier covers it");
  expect(message).toContain("Evidence standing: unverified");
  expect(message).toMatchSnapshot();
});

it("keeps multiline paths and fences within details instead of creating HTML or headings", () => {
  const message = renderReceiptMessage({ ...emptyReceipt, codeEvidence: { ...emptyReceipt.codeEvidence, unverified: ["src/<rule>\n# heading.md", "a```b.md"] } });
  expect(message).toContain("````text\n  not verified  src/<rule>\n# heading.md: no verifier covers it\n");
  expect(message).toContain("  not verified  a```b.md: no verifier covers it\n");
  expect(message).toMatchSnapshot();
});

it("says nothing was verified when a run stopped and still shows request-review status", () => {
  const receipt: Receipt = { ...emptyReceipt, stopped: "quota exhausted" };
  expect(receiptFindings(receipt)).toEqual([{ standing: "decide", check: "coverage", label: "Not verified",
    subject: "this request's changes", detail: "quota exhausted", more: [] }]);
  for (const text of [renderReceipt(receipt), renderReceiptMessage(receipt)]) {
    expect(text).toContain("quota exhausted");
    expect(text).toContain("none recorded");
    expect(text).toContain("Request review — model opinion");
    expect(text).toContain("no eligible changed contract");
    expect(text.trimEnd().endsWith("Acceptance remains with the reviewer.")).toBe(true);
  }
});
