import { expect, it } from "vitest";
import { noEvidence, receiptFindings, receiptStanding, renderReceipt, renderReceiptMessage } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

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
