import type { BranchEntry } from "../../../src/contract.ts";
import { toolResult } from "./loop.ts";
import { reconciliationText } from "./session.ts";
import type { SessionEntry } from "./session-file.ts";

/** The session's entries in file order, as Tesota reads Pi's branch (#441). */
export function branchOf(entries: readonly SessionEntry[]): BranchEntry[] {
  const branch: BranchEntry[] = [];
  const amendments = new Map<number, string>();
  for (const entry of entries) {
    if (entry.type === "request") {
      const message = { role: "user", content: entry.text, timestamp: Date.parse(entry.at) };
      branch.push({ type: "message", message });
    } else if (entry.type === "amendment") amendments.set(entry.id, entry.text);
    else if (entry.type === "delivered") {
      const message = { role: "user", content: amendments.get(entry.amendment) ?? "", timestamp: 0 };
      branch.push({ type: "message", message });
    } else if (entry.type === "clarification") {
      branch.push({ type: "custom", customType: "tesota.clarification", data: entry.clarification });
    } else if (entry.type === "assistant" || entry.type === "tool_result") branch.push({ type: "message", message: entry.message });
    else if (entry.type === "reconciliation") {
      branch.push({ type: "message",
        message: toolResult({ id: entry.callId, name: entry.toolName }, { text: reconciliationText(entry), isError: true }, 0) });
    } else if (entry.type === "custom_message") {
      const { customType, content, display, details } = entry;
      const projected = { type: "custom_message", customType, content, display, ...details === undefined ? {} : { details } };
      branch.push(projected);
    } else if (entry.type === "custom") {
      const { customType, data } = entry;
      branch.push({ type: "custom", customType, ...data === undefined ? {} : { data } });
    }
  }
  return branch;
}
