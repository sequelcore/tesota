import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { DecisionBar, decisionActions, decisionLayout, type UndecidedTurns } from "../src/tesota-shell-decision-bar.js";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";
import { decisionLevel } from "../src/verification/decision-bar-rule.js";

const one: UndecidedTurns = { turns: 1, files: 2, redoable: false };
const actions = decisionActions(one, true);

it("chooses the fullest layout that fits, as the proved rule says", () => {
  expect(decisionLevel(100, 90, 60, 40)).toBe(0);
  expect(decisionLevel(70, 90, 60, 40)).toBe(1);
  expect(decisionLevel(50, 90, 60, 40)).toBe(2);
  expect(decisionLevel(30, 90, 60, 40)).toBe(3);
});

it("says less as room runs out, a shorter hint, then none, then the count without its files", () => {
  expect(decisionLayout(one, actions, 120)).toEqual({ summary: "1 turn undecided · 2 files", hint: "or /keep /revert · a new request continues on top" });
  expect(decisionLayout(one, actions, 80)).toEqual({ summary: "1 turn undecided · 2 files", hint: "or /keep /revert" });
  expect(decisionLayout(one, actions, 60)).toEqual({ summary: "1 turn undecided · 2 files", hint: "" });
  expect(decisionLayout(one, actions, 45)).toEqual({ summary: "1 turn undecided", hint: "" });
  expect(decisionLayout({ turns: 0, files: 0, redoable: true }, ["redo"], 80)).toEqual({ summary: "Turn reverted", hint: "or /redo" });
  expect(decisionLayout({ turns: 0, files: 0, redoable: true }, ["redo"], 20)).toEqual({ summary: "Turn reverted", hint: "" });
});

it("keeps every action whole and the line within the width, never cut mid-word with an ellipsis", () => {
  const bar = new DecisionBar(tesotaShellTheme("tesota-dark"), () => ({ undecided: one, hasDiff: true }), () => undefined);
  for (const width of [120, 90, 80, 70, 60, 50, 45]) {
    const [line = ""] = bar.render(width);
    const text = stripTerminalSequences(line);
    expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
    expect(text, `width ${width}`).toContain(" Keep   Revert   Diff ");
    expect(text, `width ${width}`).not.toContain("…");
    expect(text, `width ${width}`).not.toContain("...");
  }
});
