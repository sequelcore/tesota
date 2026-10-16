import { expect, it } from "vitest";
import { receiptFindings, renderReceipt, renderReceiptMessage } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

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
