import { fauxAssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { entryReceipt, receiptGraphEntry, receiptStanding } from "../../../src/receipt.ts";
import { emptyReceipt } from "../../../tests/receipts.ts";
import { branchOf } from "../src/branch.ts";
import { repairText } from "../src/session.ts";
import type { SessionEntry } from "../src/session-file.ts";

test("graph-bearing transcript messages restore the same receipt standing without exporting metadata", () => {
  const message = receiptGraphEntry("tui", emptyReceipt, [{ subject: "Counter.tla", capture: { status: "limited", reason: "limit" } }]);
  const entries = JSON.parse(JSON.stringify([{ ...message, run: 1 }])) as SessionEntry[];
  const restored = branchOf(entries).at(-1);
  expect(restored).toBeDefined();
  if (restored === undefined) return;
  const receipt = entryReceipt(restored);
  expect(receipt).toEqual(emptyReceipt);
  expect(receiptStanding(receipt as typeof emptyReceipt)).toBe(receiptStanding(emptyReceipt));
  expect(receipt).not.toHaveProperty("graphs");
});

/** The session's entries as Tesota reads them on Pi's branch (#441). */
test("a fresh session has no branch entries", () => {
  expect(branchOf([])).toEqual([]);
});

test("requests, replies, repairs, extension entries and delivered amendments keep their branch shapes and file order", () => {
  const at = "2026-10-16T00:00:00.000Z";
  const reply = fauxAssistantMessage([
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "file.txt" } },
    { type: "toolCall", id: "write-1", name: "write", arguments: { path: "file.txt", content: "changed" } },
    { type: "toolCall", id: "read-2", name: "read", arguments: { path: "other.txt" } },
  ], { stopReason: "toolUse", timestamp: 0 });
  const result: ToolResultMessage = { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "contents" }],
    details: { path: "file.txt" }, isError: false, timestamp: 0 };
  const receipt = { version: 2, proofs: [], tests: [], uncovered: [] };
  const entries: SessionEntry[] = [
    { type: "request", run: 1, text: "change the file", origin: "rpc", at, base: { units: [] } },
    { type: "amendment", run: 1, id: 1, behavior: "steer", origin: "interactive", text: "also check it", at },
    { type: "amendment", run: 1, id: 2, behavior: "followUp", origin: "extension", text: "not delivered", at },
    { type: "assistant", run: 1, message: reply },
    { type: "call_intent", run: 1, callId: "read-1", access: "read" },
    { type: "tool_result", run: 1, message: result },
    { type: "call_intent", run: 1, callId: "write-1", access: "write" },
    { type: "reconciliation", run: 1, reply: 0, callId: "write-1", toolName: "write", repair: "outcome_unknown" },
    { type: "reconciliation", run: 1, reply: 0, callId: "read-2", toolName: "read", repair: "not_run" },
    { type: "settle", run: 1, generation: 0, phase: "extensions", outcome: "completed" },
    { type: "custom_message", run: 1, customType: "tesota-send-back", content: "fix the failing check", display: false },
    { type: "custom_message", run: 1, customType: "tesota-receipt", content: "the receipt", display: true, details: receipt },
    { type: "custom", run: 1, customType: "tesota-receipt", data: receipt },
    { type: "settled", run: 1, generation: 0, phase: "extensions", continued: true, errors: [], registered: true },
    { type: "delivered", run: 1, amendment: 1 },
    { type: "settle", run: 1, generation: 0, phase: "verifier", outcome: "completed" },
    { type: "settled", run: 1, generation: 0, phase: "verifier", continued: false, errors: [], registered: true },
    { type: "run_end", run: 1, outcome: "completed" },
  ];
  const before = structuredClone(entries);
  const branch = branchOf(entries);
  const expected = [
    { type: "message", message: { role: "user", content: "change the file", timestamp: Date.parse(at) } },
    { type: "message", message: reply },
    { type: "message", message: result },
    { type: "message", message: { role: "toolResult", toolCallId: "write-1", toolName: "write",
      content: [{ type: "text", text: repairText.outcome_unknown }], isError: true, timestamp: 0 } },
    { type: "message", message: { role: "toolResult", toolCallId: "read-2", toolName: "read",
      content: [{ type: "text", text: repairText.not_run }], isError: true, timestamp: 0 } },
    { type: "custom_message", customType: "tesota-send-back", content: "fix the failing check", display: false },
    { type: "custom_message", customType: "tesota-receipt", content: "the receipt", display: true, details: receipt },
    { type: "custom", customType: "tesota-receipt", data: receipt },
    { type: "message", message: { role: "user", content: "also check it", timestamp: 0 } },
  ];
  expect(branch).toEqual(expected);
  expect(branch.filter((entry) => entry.customType === "tesota-receipt").map(entryReceipt)).toEqual([receipt, receipt]);
  expect(branch.findLastIndex((entry) => entry.type === "message" && entry.message?.role === "user")).toBe(8);
  expect(entries).toEqual(before);
});
