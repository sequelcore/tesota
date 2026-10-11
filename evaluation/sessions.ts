import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Receipt } from "../src/receipt.js";

/** What the live evaluations share: the project files they write and what a Pi session file records. */

export const manifest: string = JSON.stringify({ type: "module", scripts: { test: "node --test" } }, null, 2);

export function write(directory: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
}

export const read = (path: string): string | undefined => existsSync(path) ? readFileSync(path, "utf8") : undefined;

/** The fields of a Pi session entry the suite reads. */
interface SessionEntry {
  readonly type: string;
  readonly customType?: string;
  readonly content?: unknown;
  readonly details?: unknown;
  readonly thinkingLevel?: string;
  readonly message?: { readonly role: string;
    readonly content?: readonly { readonly type: string; readonly name?: string; readonly text?: string }[] | string;
    readonly usage?: Readonly<Record<string, number>> };
}

/** What the session file records: the model's usage and requests, the tools run, what went back, and the last receipt. */
export function sessionFacts(sessions: string): Record<string, unknown> {
  const files = existsSync(sessions) ? readdirSync(sessions, { recursive: true }).map(String).filter((path) => path.endsWith(".jsonl")) : [];
  const entries = files.flatMap((path) => (read(join(sessions, path)) ?? "").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as SessionEntry));
  const assistant = entries.flatMap((entry) => entry.type === "message" && entry.message?.role === "assistant" ? [entry.message] : []);
  const tools = assistant.flatMap((message) => typeof message.content === "string" ? []
    : (message.content ?? []).filter((part) => part.type === "toolCall").map((part) => part.name));
  const gate = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "tesota-gate").map((entry) => String(entry.content));
  const receipts = entries.filter((entry) => entry.type === "custom_message" && entry.customType === "tesota-receipt");
  const sum = (key: string): number => assistant.reduce((total, message) => total + (message.usage?.[key] ?? 0), 0);
  // The prove tool's result, or the gate's message, that carries the note on a proof that verified nothing.
  const vacuous = (text: string): boolean => text.includes("Dafny verified nothing");
  const results = entries.flatMap((entry) => entry.type === "message" && entry.message?.role === "toolResult" &&
    typeof entry.message.content !== "string" ? [(entry.message.content ?? []).map((part) => part.text ?? "").join("\n")] : []);
  return {
    sessions: files.length, modelRequests: assistant.length, tokens: { input: sum("input"), output: sum("output"),
      cacheRead: sum("cacheRead"), total: sum("totalTokens") },
    thinking: entries.find((entry) => entry.type === "thinking_level_change")?.thinkingLevel,
    tools: tools.length, proveCalls: tools.filter((name) => name === "prove").length,
    sentBack: { proof: gate.filter((text) => text.includes("does not prove yet")).length,
      tests: gate.filter((text) => text.includes("fails with your changes")).length,
      weak: gate.filter((text) => text.startsWith("Tesota: the contract of")).length },
    vacuousProofs: { prove: results.filter(vacuous).length, gate: gate.filter(vacuous).length },
    receipt: receipts.at(-1)?.details as Receipt | undefined,
  };
}
