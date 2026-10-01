import { truncateToWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { acceptsShellTheme } from "../src/verification/shell-theme-rule.js";
import { bold, parseTesotaShellTheme, selectedRow, shellSurfaces, tesotaShellTheme, TESOTA_SHELL_THEME_NAMES } from "../src/tesota-shell-theme.js";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

it.each(TESOTA_SHELL_THEME_NAMES)("accepts and renders the catalog theme %s", (name) => {
  expect(acceptsShellTheme(name)).toBe(true);
  expect(parseTesotaShellTheme(name)).toBe(name);
  expect(tesotaShellTheme(name).name).toBe(name);
});

it.each(["", "unknown", "Vesper", "vesper ", "dark", "tesota", "automata-dark"])("rejects a theme outside the catalog: %s", (name) => {
  expect(acceptsShellTheme(name)).toBe(false);
  expect(parseTesotaShellTheme(name)).toBeUndefined();
});

it.each(TESOTA_SHELL_THEME_NAMES.filter((name) => name !== "terminal"))(
  "keeps %s's text legible on painted backgrounds and compatible terminal canvases", (name) => {
    const theme = tesotaShellTheme(name);
    const foreground = theme.foreground ?? "";
    for (const background of [theme.userBackground, theme.selectionBackground, theme.addedBackground, theme.removedBackground]) {
      expect(contrast(foreground, background ?? ""), `${name}: foreground on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    const canvas = theme.canvas ?? "";
    for (const color of [theme.muted, theme.accent, theme.success, theme.warning, theme.error]) {
      expect(contrast(color ?? "", canvas), `${name}: ${color} on ${canvas}`).toBeGreaterThanOrEqual(4.5);
    }
    // A panel's surface keeps every color of its text legible, stands apart from the canvas, and keeps a selected row visible.
    const panel = theme.panelBackground ?? "";
    for (const color of [theme.foreground, theme.muted, theme.accent, theme.warning, theme.error]) {
      expect(contrast(color ?? "", panel), `${name}: ${color} on the panel's ${panel}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(panel, canvas), `${name}: panel on canvas`).toBeGreaterThanOrEqual(1.1);
    expect(contrast(theme.selectionBackground ?? "", panel), `${name}: selection on panel`).toBeGreaterThanOrEqual(1.2);
    expect(theme.accent).not.toBe(theme.success);
    expect(theme.accent).not.toBe(theme.warning);
    expect(selectedRow("selected", 20, theme)).toContain("\x1b[38;2;");
    // The side surface under the sidebar and the result panel stands apart from the conversation's canvas, keeps every
    // color of its text legible and a selected row visible, and its rule shows against it.
    const { side, rule } = shellSurfaces(theme);
    expect(contrast(side ?? "", canvas), `${name}: side surface on canvas`).toBeGreaterThanOrEqual(1.1);
    for (const color of [theme.foreground, theme.muted, theme.accent, theme.success, theme.warning, theme.error]) {
      expect(contrast(color ?? "", side ?? ""), `${name}: ${color} on the side surface ${side}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(theme.selectionBackground ?? "", side ?? ""), `${name}: selection on the side surface`).toBeGreaterThanOrEqual(1.2);
    expect(contrast(rule ?? "", side ?? ""), `${name}: rule on the side surface`).toBeGreaterThanOrEqual(1.4);
    // The input and the operator's messages are filled with their background, which must show on the canvas.
    expect(contrast(theme.userBackground ?? "", canvas), `${name}: the operator's background on canvas`).toBeGreaterThanOrEqual(1.05);
  },
);

it("steps the side surface from the terminal's own background once it is known, toward the text, and leaves none without colors", () => {
  const dark = tesotaShellTheme("tesota-dark");
  const reported = shellSurfaces(dark, "#0c0c0c").side ?? "";
  expect(reported).not.toBe(shellSurfaces(dark).side);
  expect(contrast(reported, "#0c0c0c")).toBeGreaterThanOrEqual(1.1);
  expect(luminance(reported)).toBeGreaterThan(luminance("#0c0c0c"));
  const light = tesotaShellTheme("tesota-light");
  expect(luminance(shellSurfaces(light).side ?? "")).toBeLessThan(luminance(light.canvas ?? ""));
  expect(shellSurfaces(tesotaShellTheme("terminal"))).toEqual({ side: null, rule: null });
});

it("keeps a truncated row selected to its end, past the reset truncation leaves before its ellipsis", () => {
  const theme = tesotaShellTheme("tesota-dark");
  // pi-tui ends a cut styled line with a full reset before "...", as the sidebar's long session titles are cut.
  const cut = truncateToWidth(` ${bold("Build and test filesystem scanner")}`, 22);
  expect(cut).toContain("\x1b[0m...");
  const row = selectedRow(cut, 25, theme);
  const background = `\x1b[48;2;${theme.selectionBackground!.slice(1).match(/../gu)!.map((hex) => Number.parseInt(hex, 16)).join(";")}m`;
  // After every reset, the selection's background is laid again, so the ellipsis and the padding stay selected.
  const resets: number[] = [];
  for (let at = row.indexOf("\x1b[0m"); at >= 0; at = row.indexOf("\x1b[0m", at + 1)) resets.push(at);
  expect(resets.length).toBeGreaterThan(0);
  for (const index of resets) expect(row.slice(index + "\x1b[0m".length).startsWith(background)).toBe(true);
  const terminal = tesotaShellTheme("terminal");
  expect(selectedRow(cut, 25, terminal)).toContain("\x1b[0m\x1b[7m...");
});
