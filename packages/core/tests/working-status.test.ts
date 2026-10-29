import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, expect, jest, test } from "bun:test";
import type { WorkingIndicator } from "../../../src/contract.ts";
import { shellTheme } from "../../../src/theme.ts";
import { ORB_FRAME_MS, workingOrb } from "../../../src/working-orb.ts";
import { WorkingStatus } from "../src/shell/working-status.ts";

const theme = shellTheme("dark", "truecolor");
const still = (rows: readonly string[]) => ({ frames: [rows], intervalMs: 80 });
/** An indicator whose phases are told apart by their letters: two rows each, and two frames for the model at work. */
const indicator: WorkingIndicator = { phases: {
  working: { frames: [["W1", "w1"], ["W2", "w2"]], intervalMs: 80 },
  verifying: still(["VV", "vv"]), compacting: still(["CC", "cc"]), retrying: still(["RR", "rr"]),
} };
const plain = (status: WorkingStatus, width = 60): string[] => status.render(width).map((row) => stripTerminalSequences(row).trimEnd());

afterEach(() => { jest.useRealTimers(); });

test("draws the phase's orb, rows tall, beside the message's lines, under one blank row", () => {
  const status = new WorkingStatus({ requestRender: () => undefined }, theme);
  status.setIndicator(() => indicator);
  status.show("verifying", "Verifying… · Esc: stop\nProof · src/a.ts · 0:02");
  expect(plain(status)).toEqual(["", " VV Verifying… · Esc: stop", " vv Proof · src/a.ts · 0:02"]);
  status.show("retrying", "Retry 1/3 in 4s · Esc to cancel");
  expect(plain(status)).toEqual(["", " RR Retry 1/3 in 4s · Esc to cancel", " rr"]);
  status.show("compacting", "Compacting…");
  expect(plain(status)[1]).toBe(" CC Compacting…");
});

test("plays the phase's frames only while it runs, from the first frame when the phase changes", () => {
  jest.useFakeTimers();
  let renders = 0;
  const status = new WorkingStatus({ requestRender: () => { renders++; } }, theme);
  status.setIndicator(() => indicator);
  status.show("working", "Working…");
  jest.advanceTimersByTime(400);
  expect(plain(status)[1]).toBe(" W1 Working…");
  status.start();
  jest.advanceTimersByTime(80);
  expect(plain(status)[1]).toBe(" W2 Working…");
  status.show("verifying", "Verifying…");
  status.show("working", "Working…");
  expect(plain(status)[1]).toBe(" W1 Working…");
  status.stop();
  const before = renders;
  jest.advanceTimersByTime(800);
  expect(renders).toBe(before);
});

test("wraps a long message beside the orb and keeps every row within the width", () => {
  const status = new WorkingStatus({ requestRender: () => undefined }, theme);
  status.setIndicator(() => indicator);
  status.show("verifying", "Verifying… running the project check over every package in the workspace");
  for (const row of status.render(30)) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
  expect(plain(status, 30).slice(1).every((row) => row.startsWith(" VV ") || row.startsWith(" vv ") || row.startsWith("    "))).toBe(true);
});

test("without an indicator, shows the shell's own one-row spinner in the accent", () => {
  const status = new WorkingStatus({ requestRender: () => undefined }, theme);
  status.show("working", "Working…");
  const [, row] = status.render(40);
  expect(stripTerminalSequences(row ?? "")).toBe(" ⠋ Working…");
  expect(row).toContain(theme.fg("accent", "⠋"));
});

test("redraws Tesota's orb in the new appearance when the terminal turns light or dark mid-run", () => {
  jest.useFakeTimers();
  const look = shellTheme("dark", "truecolor");
  const status = new WorkingStatus({ requestRender: () => undefined }, look);
  status.setIndicator(workingOrb);
  status.show("working", "Working…");
  status.start();
  jest.advanceTimersByTime(ORB_FRAME_MS * 3);
  const dark = status.render(40);
  expect(dark[1]).toContain(workingOrb(look).phases.working.frames[3]![0]!);
  look.use("light");
  const light = status.render(40);
  // The same frame of the same loop, in the light theme's colors: the run never restarted.
  expect(light[1]).toContain(workingOrb(look).phases.working.frames[3]![0]!);
  expect(light[1]).not.toBe(dark[1]);
  expect(light.map((row) => stripTerminalSequences(row))).toEqual(dark.map((row) => stripTerminalSequences(row)));
  status.stop();
});
