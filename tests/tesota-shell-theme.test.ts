import { expect, it } from "vitest";
import { acceptsShellTheme } from "../src/verification/shell-theme-rule.js";
import { parseTesotaShellTheme, selectedRow, tesotaShellTheme, TESOTA_SHELL_THEME_NAMES } from "../src/tesota-shell-theme.js";

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
    const canvas = name === "automata" ? "#ccc8b1" : theme.appearance === "light" ? "#edede5" : "#202020";
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
  },
);
