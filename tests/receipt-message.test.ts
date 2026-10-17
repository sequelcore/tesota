import { expect, it } from "vitest";
import { noEvidence, receiptFindings, receiptStanding, renderReceipt, renderReceiptMessage } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

it("says a receipt in one word: verified when clean, failed when a check failed, even in a unit, incomplete otherwise (#455)", () => {
  expect(receiptStanding(emptyReceipt)).toBe("verified");
  expect(receiptStanding({ ...emptyReceipt, stopped: "the operator stopped the run" })).toBe("incomplete");
  const failing = { command: "npm test", verdict: "send_back" as const, evidence: { verifier: "command" as const, claim: "the tests pass",
    limits: "", outcome: "failed" as const, output: "1 failed", durationMs: 1, files: [], contentHash: "" } };
  expect(receiptStanding({ ...emptyReceipt, tests: [failing] })).toBe("failed");
  // A folder of repositories keeps its checks in its units, not at the top.
  expect(receiptStanding({ ...emptyReceipt, repository: false, units: [{ ...noEvidence, folder: "app", repository: true, base: null,
    tests: [failing] }] })).toBe("failed");
});

it("makes the chat receipt readable without hiding unchecked changes or interpreting their names as Markdown", () => {
  expect(renderReceiptMessage({ ...emptyReceipt, unverified: ["src/[rule]*.ts"] })).toBe(
    "## Tesota receipt\n\n- **not verified** — src/\\[rule\\]\\*.ts: no verifier covers it\n\n" +
    "This is check evidence, not your acceptance.");
});

it("keeps multiline names inside their evidence item instead of creating a heading or HTML", () => {
  expect(renderReceiptMessage({ ...emptyReceipt, unverified: ["src/<rule>\n# heading.md"] })).toBe(
    "## Tesota receipt\n\n- **not verified** — src/\\<rule\\>\n  \\# heading.md: no verifier covers it\n\n" +
    "This is check evidence, not your acceptance.");
});

it("says nothing was verified when the run stopped, and why", () => {
  const receipt = { ...emptyReceipt, stopped: "quota exhausted" };
  expect(receiptFindings(receipt)).toEqual([{ standing: "decide", check: "coverage", label: "Not verified",
    subject: "this request's changes", detail: "quota exhausted", more: [] }]);
  expect(renderReceipt(receipt)).toBe("Tesota receipt\n  not verified  this request's changes: quota exhausted");
  expect(renderReceiptMessage(receipt)).toBe("## Tesota receipt\n\n" +
    "- **not verified** — this request's changes: quota exhausted\n\nThis is check evidence, not your acceptance.");
});
