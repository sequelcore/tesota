import { SelectList, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { listRow, shellTheme } from "../src/theme.js";

it.each(["dark", "light"] as const)("draws a full-width selected %s list row without changing the other row", (appearance) => {
  const theme = shellTheme(appearance, "truecolor");
  const list = new SelectList([{ value: "first", label: "first", description: "First choice" }, { value: "second", label: "second", description: "Second choice" }], 5, theme.selectList);
  const rows = list.render(60).map((line) => listRow(theme, line, 60));
  expect(stripTerminalSequences(rows[0]!)).toBe(`› first${" ".repeat(27)}First choice${" ".repeat(14)}`);
  expect(visibleWidth(rows[0]!)).toBe(60);
  expect(rows[0]).toBe(theme.bg("selectedBg", theme.fg("text", `› first${" ".repeat(27)}First choice`) + " ".repeat(14)));
  expect(rows[1]).toBe(list.render(60)[1]);
  expect(rows[1]).not.toContain(theme.getBgAnsi("selectedBg"));
});

it("keeps the selection marker without colors", () => {
  vi.stubEnv("NO_COLOR", "1");
  try {
    const theme = shellTheme("dark", "truecolor");
    const list = new SelectList([{ value: "first", label: "first" }, { value: "second", label: "second" }], 5, theme.selectList);
    expect(list.render(12).map((line) => listRow(theme, line, 12))).toEqual(["› first     ", "  second"]);
  } finally { vi.unstubAllEnvs(); }
});
