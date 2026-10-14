import { expect, it } from "vitest";
import { renderReceiptMessage } from "../src/receipt.js";
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
