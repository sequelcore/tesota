import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { hang, registerMessages, shortHash } from "../src/messages.js";
import { loadThemes, themeIn } from "./pi-themes.js";

let theme: Theme;
beforeAll(async () => { theme = themeIn(await loadThemes(), "tesota-dark"); }, 30_000);

function renderers(): Map<string, MessageRenderer> {
  const found = new Map<string, MessageRenderer>();
  registerMessages({ registerMessageRenderer: (type: string, renderer: MessageRenderer) => { found.set(type, renderer); } } as never);
  return found;
}

function shown(type: string, content: string, width: number): string[] {
  const message = { role: "custom" as const, customType: type, content, display: true, timestamp: 0 };
  const component = renderers().get(type)?.(message, { expanded: false, outputPad: 1 }, theme);
  if (component === undefined) throw new Error(`no renderer for ${type}`);
  const rows = component.render(width);
  for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
  expect(content).toBe(message.content);
  return rows.map(stripTerminalSequences);
}

const hash = "5f1c0a9e3b7d42c6a18e9f0b2d4c6e8a0b1c3d5e7f9a1b3c5d7e9f0a2b4c6d8e";
const receipt = ["Tesota receipt", "  proved        src/clamp.ts", `                content sha256 ${hash}`,
  "  model judged  by ClaimCheck on openai/gpt-5.5, one model for both requests, a model's judgment against the request, not a proof:",
  "  not proved    src/parse.ts lines 12-14: outside the contracts that proved; the project's commands pass with them"].join("\n");

it("wraps a line under its own text, cutting a word longer than the row", () => {
  expect(hang("  label         one two three four", 22, 16)).toEqual(["  label         one", "                two", "                three",
    "                four"]);
  expect(hang("  - a long line that wraps", 12, 4)).toEqual(["  - a long", "    line", "    that", "    wraps"]);
  expect(hang(`x ${hash}`, 20, 2)).toEqual(["x", `  ${hash.slice(0, 18)}`, `  ${hash.slice(18, 36)}`, `  ${hash.slice(36, 54)}`,
    `  ${hash.slice(54)}`]);
  expect(hang("short", 20, 2)).toEqual(["short"]);
});

it("shows the receipt under a styled title, wrapping under each line's text and with the hash shortened", () => {
  const rows = shown("tesota-receipt", receipt, 80);
  expect(rows.join("\n")).not.toContain("[tesota-receipt]");
  expect(rows[1]?.trim()).toBe("Tesota receipt");
  expect(rows.join("\n")).toContain(`content sha256 ${hash.slice(0, 12)}…`);
  expect(rows.join("\n")).not.toContain(hash);
  const judged = rows.findIndex((row) => row.includes("model judged"));
  // The continuation starts under the text, past the box's padding and the receipt's sixteen columns.
  expect(rows[judged + 1]?.startsWith(" ".repeat(17))).toBe(true);
  expect(rows[judged + 1]?.[17]).not.toBe(" ");
  expect(shortHash(`content sha256 ${hash}`)).toBe(`content sha256 ${hash.slice(0, 12)}…`);
  expect(shortHash("content sha256 hash of src/rule.ts")).toBe("content sha256 hash of src/rule.ts");
});

it("shows what went back to the agent under a styled title", () => {
  const content = "Tesota: the contract of clamp in src/clamp.ts proves, but these changes to its code prove too, so it does not rule them out:\n" +
    "  line 4: x > hi became x >= hi\n\nStrengthen the contract so its proof rules out what the request does not allow.";
  const rows = shown("tesota-gate", content, 80);
  expect(rows[1]?.trim()).toBe("Tesota · sent back to the agent");
  expect(rows.join("\n")).not.toContain("[tesota-gate]");
  expect(rows[3]?.trimEnd()).toBe(" Tesota: the contract of clamp in src/clamp.ts proves, but these changes to its");
  expect(rows[4]?.trimEnd()).toBe(" code prove too, so it does not rule them out:");
  expect(rows[5]?.trimEnd()).toBe("   line 4: x > hi became x >= hi");
});
