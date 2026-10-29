import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import type { WorkPhase } from "../src/contract.js";
import { shellTheme } from "../src/theme.js";
import { ORB_FRAME_MS, workingOrb } from "../src/working-orb.js";

const phases: readonly WorkPhase[] = ["working", "verifying", "compacting", "retrying"];
/** Every truecolor foreground and background in a frame, as `r;g;b`. */
// eslint-disable-next-line no-control-regex -- inspect terminal color SGRs
const inks = (rows: readonly string[]): string[] => [...rows.join("").matchAll(/\x1b\[[34]8;2;(\d+;\d+;\d+)m/gu)].map(([, rgb]) => rgb!);

it("draws each phase as a round orb, four columns by two rows of half blocks, looping in whole frames", () => {
  const orb = workingOrb(shellTheme("dark", "truecolor"));
  expect(ORB_FRAME_MS).toBe(80);
  const loops = { working: 2400, verifying: 1600, compacting: 2000, retrying: 3200 };
  for (const phase of phases) {
    const { frames, intervalMs } = orb.phases[phase];
    expect(intervalMs).toBe(ORB_FRAME_MS);
    expect(frames).toHaveLength(loops[phase] / ORB_FRAME_MS);
    for (const rows of frames) {
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(visibleWidth(row)).toBe(4);
        expect(stripTerminalSequences(row)).toBe("▀▀▀▀");
      }
    }
  }
});

it("moves differently in each phase, so the orb says what the run is doing", () => {
  const orb = workingOrb(shellTheme("dark", "truecolor"));
  const loops = phases.map((phase) => orb.phases[phase].frames.map((rows) => inks(rows).join(" ")).join("|"));
  expect(new Set(loops).size).toBe(phases.length);
  // Each one moves: no phase holds one frame for its whole loop.
  for (const phase of phases) expect(new Set(orb.phases[phase].frames.map((rows) => rows.join(""))).size).toBeGreaterThan(4);
});

it.each(["dark", "light"] as const)("is neutral ink while the model works, and the accent only while Tesota verifies (%s)", (appearance) => {
  const theme = shellTheme(appearance, "truecolor");
  const orb = workingOrb(theme);
  const accent = theme.colors["accent"]!;
  const hue = (rgb: string): number => { const [r, g, b] = rgb.split(";").map(Number) as [number, number, number]; return b - (r + g) / 2; };
  const bluest = (phase: WorkPhase): number => Math.max(...orb.phases[phase].frames.flatMap((rows) => inks(rows).map(hue)));
  expect("r" in accent && accent.b - (accent.r + accent.g) / 2).toBeGreaterThan(40);
  expect(bluest("verifying")).toBeGreaterThan(40);
  for (const phase of ["working", "compacting", "retrying"] as const) expect(bluest(phase)).toBeLessThan(12);
});

it("blends its edge into the theme's canvas, and follows the theme, its color mode and its appearance", () => {
  const theme = shellTheme("dark", "truecolor");
  const orb = workingOrb(theme);
  expect(workingOrb(theme)).toBe(orb);
  // A corner pixel lies mostly outside the sphere, so it stays near the canvas; a pixel inside it does not.
  const canvas = theme.colors["pageBg"]!;
  const away = (rgb: string): number => "r" in canvas
    ? rgb.split(";").map(Number).reduce((sum, value, k) => sum + Math.abs(value - [canvas.r, canvas.g, canvas.b][k]!), 0) : 0;
  const first = inks(orb.phases.working.frames[0]!);
  // Cell by cell, a top pixel then its bottom one: the top-left corner first, the pixel under the next cell's top fourth.
  expect(away(first[0]!)).toBeLessThan(away(first[3]!));
  expect(away(first[0]!)).toBeLessThan(150);
  const indexed = workingOrb(shellTheme("dark", "256color")).phases.working.frames.flat().join("");
  expect(indexed).toContain("\x1b[38;5;");
  expect(indexed).not.toContain("\x1b[38;2;");
  theme.use("light");
  expect(workingOrb(theme)).not.toEqual(orb);
});

it("stands still as a plain silhouette where the terminal shows no extended colors", () => {
  const before = process.env["NO_COLOR"];
  process.env["NO_COLOR"] = "1";
  try {
    const orb = workingOrb(shellTheme("dark", "truecolor"));
    for (const phase of phases) expect(orb.phases[phase].frames).toEqual([["▗██▖", "▝██▘"]]);
  } finally {
    if (before === undefined) delete process.env["NO_COLOR"]; else process.env["NO_COLOR"] = before;
  }
});
