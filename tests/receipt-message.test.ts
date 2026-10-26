import { expect, it } from "vitest";
import { noEvidence, receiptFindings, receiptStanding, renderReceipt, renderReceiptMessage } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";
import { receiptMarkdown, receiptStatement } from "../src/pull-request-receipt.js";
import { unitReceipt } from "../src/receipt.js";

it("stores and exports the requests each judge received and names context omissions (#627)", () => {
  const requestJudgments = [{ method: "claimcheck" as const, folder: "app", requests: [
    { run: 1, text: ["Original requirement", "Amendment"] }, { run: 3, text: ["continue"] },
  ], omitted: [2] }];
  const receipt = JSON.parse(JSON.stringify({ ...emptyReceipt, requestJudgments }));
  const subject = { commit: "abc", owner: "operator", sessionId: "session", stale: [], changedAfter: [] };
  expect(receipt.requestJudgments).toEqual(requestJudgments);
  for (const text of [renderReceipt(receipt), renderReceiptMessage(receipt), receiptMarkdown(receipt, subject)]) {
    expect(text).toContain("ClaimCheck context: requests 1 and 3");
    expect(text).toContain("left out request 2: context capacity");
  }
  expect(receiptStatement(receipt, subject, "2026-10-26", "COMPLETED"))
    .toMatchObject({ predicate: { custom: { receipt: { requestJudgments } } } });
  const openContext = { method: "open_cases" as const, folder: "", requests: [{ run: 3, text: ["continue"] }], omitted: [] };
  const openCases = { status: "not_listed" as const, reason: "test/lister: provider unavailable" };
  const workspace = { ...receipt, openCases, requestJudgments: [...requestJudgments,
    { method: "claimcheck" as const, folder: "other", requests: [{ run: 3, text: ["continue"] }], omitted: [1, 2] }, openContext],
    units: [{ ...emptyReceipt, folder: "app" }] };
  expect(unitReceipt(workspace, "app")?.requestJudgments).toEqual([...requestJudgments, openContext]);
  expect(unitReceipt(workspace, "app")?.openCases).toEqual(openCases);
  expect(receiptMarkdown(unitReceipt(workspace, "app")!, subject)).toContain("test/lister: provider unavailable");
  expect(receiptMarkdown(unitReceipt(workspace, "app")!, subject)).not.toContain("left out requests 1 and 2");
  expect(renderReceipt(receipt)).toMatchSnapshot();
  // An absent optional context field (including in existing local sessions) needs no migration.
  expect(() => renderReceipt(emptyReceipt)).not.toThrow();
});

it("says a receipt in one word: nothing to claim when nothing changed, failed when a check failed, even in a unit, incomplete otherwise (#455, #668)", () => {
  expect(receiptStanding(emptyReceipt)).toBe("unchanged");
  expect(receiptStanding({ ...emptyReceipt, stopped: "the operator stopped the run" })).toBe("incomplete");
  const failing = { command: "npm test", verdict: "send_back" as const, evidence: { verifier: "command" as const, claim: "the tests pass",
    limits: "", outcome: "failed" as const, output: "1 failed", durationMs: 1, files: [], contentHash: "" } };
  expect(receiptStanding({ ...emptyReceipt, tests: [failing] })).toBe("failed");
  // A folder of repositories keeps its checks in its units, not at the top.
  expect(receiptStanding({ ...emptyReceipt, repository: false, units: [{ ...noEvidence, folder: "app", repository: true, base: null,
    tests: [failing] }] })).toBe("failed");
});

const methods = "- ○ **Tested** — none recorded\n- ○ **Proved** — none recorded\n- ○ **Models** — none recorded";

it("makes the chat receipt readable without hiding unchecked changes or interpreting their names as Markdown", () => {
  expect(renderReceiptMessage({ ...emptyReceipt, unverified: ["src/[rule]*.ts"] })).toBe(
    "## Tesota receipt\n\n**No review flags · 1 verification limit**  \nCheck evidence, not your acceptance.\n\n" +
    `${methods}\n\n- ○ No proof covers 1 changed file — Not checked by anything else.\n\n` +
    "**Details**\n\n```text\n  not verified  src/[rule]*.ts: no verifier covers it\nFrom the first commit · Tesota 0.1.0\n```");
});

it("keeps multiline names and fences inside the fenced details instead of creating a heading or HTML", () => {
  const message = renderReceiptMessage({ ...emptyReceipt, unverified: ["src/<rule>\n# heading.md", "a```b.md"] });
  expect(message).toContain("````text\n  not verified  src/<rule>\n# heading.md: no verifier covers it\n");
  expect(message).toContain("  not verified  a```b.md: no verifier covers it\n");
  expect(message.endsWith("\n````")).toBe(true);
});

it("says nothing was verified when the run stopped, and why", () => {
  const receipt = { ...emptyReceipt, stopped: "quota exhausted" };
  expect(receiptFindings(receipt)).toEqual([{ standing: "decide", check: "coverage", label: "Not verified",
    subject: "this request's changes", detail: "quota exhausted", more: [] }]);
  expect(renderReceipt(receipt)).toBe("Tesota receipt\n1 review flag · no verification limits\nCheck evidence, not your acceptance.\n\n" +
    "○ Tested   none recorded\n○ Proved   none recorded\n○ Models   none recorded\n\n! Not verified · this request's changes\n" +
    "  quota exhausted\n\nDetails\n  not verified  this request's changes: quota exhausted\nFrom the first commit · Tesota 0.1.0");
  expect(renderReceiptMessage(receipt)).toBe("## Tesota receipt\n\n**1 review flag · no verification limits**  \n" +
    `Check evidence, not your acceptance.\n\n${methods}\n\n- ! Not verified · this request's changes — quota exhausted\n\n` +
    "**Details**\n\n```text\n  not verified  this request's changes: quota exhausted\nFrom the first commit · Tesota 0.1.0\n```");
});
