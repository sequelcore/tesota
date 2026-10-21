import { expect, it } from "vitest";
import { clarificationText, type Clarification } from "../src/clarification.js";
import { receiptStanding, renderReceipt, renderReceiptMessage, unitReceipt } from "../src/receipt.js";
import { emptyReceipt } from "./receipts.js";

it("attributes the chosen option and preserves qualifying operator text", () => {
  const answer: Clarification = { reply: 0, callId: "choice", at: "2026-10-20T00:00:00.000Z",
    questions: [{ question: "How should people sign in?", options: [
      { label: "Google", description: "Use Google accounts." }, { label: "Password", description: "Keep passwords." },
    ] }], answers: [{ selected: [0], text: "But explain first.\nDo not implement yet." }] };
  expect(clarificationText(answer)).toBe(
    "Agent question: How should people sign in?\nOperator selected: Google — Use Google accounts.\n" +
    "Operator text (verbatim):\nBut explain first.\nDo not implement yet.");
});

it("keeps submitted answers in receipt context without changing verification or acceptance", () => {
  const clarification: Clarification = { reply: 1, callId: "answer", at: "2026-10-20T00:00:00.000Z",
    questions: [{ question: "Which version?", options: [
      { label: "Three", description: "Use version three." }, { label: "Two", description: "Use version two." },
    ] }], answers: [{ selected: [0], text: "Explain before implementing." }] };
  const receipt = { ...emptyReceipt, clarifications: [clarification] };
  expect(receiptStanding(receipt)).toBe(receiptStanding(emptyReceipt));
  expect(renderReceipt(receipt)).toContain("Request clarification (operator input, not evidence or acceptance)");
  expect(renderReceipt(receipt)).toContain("Operator text (verbatim):\nExplain before implementing.");
  expect(renderReceiptMessage(receipt)).toContain("Explain before implementing.");
  expect(renderReceipt({ ...receipt, stopped: "stopped" })).toContain("Explain before implementing.");
  expect(unitReceipt({ ...receipt, units: [{ ...emptyReceipt, folder: "app" }] }, "app")?.clarifications).toEqual([clarification]);
});
