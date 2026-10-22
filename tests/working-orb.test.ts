import { Loader, ProcessTerminal, TuiMainScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { shellTheme } from "../src/theme.js";
import { ORB_FRAME_MS, orbFrame, orbFrames } from "../src/welcome-header.js";

it("turns in a fixed 3×1 footprint in an exact 2.4 second loop, never holding a mask past 240 ms", () => {
  const theme = shellTheme("dark", "truecolor");
  const frames = orbFrames(theme);
  expect(frames).toHaveLength(30);
  expect(ORB_FRAME_MS).toBe(80);
  const masks = frames.map(stripTerminalSequences);
  for (let i = 0; i < frames.length; i++) {
    expect(visibleWidth(frames[i] ?? "")).toBe(3);
    expect(frames[i]).not.toMatch(/[\n⣿]/u);
    expect(orbFrame(theme, i + 30)).toBe(frames[i]);
    expect(orbFrame(theme, i - 30)).toBe(frames[i]);
    expect([1, 2, 3].some(step => masks[(i + step) % 30] !== masks[i])).toBe(true);
  }
});

for (const appearance of ["dark", "light"] as const) {
  it(`uses stronger near-side ink in ${appearance} and follows theme roles and color mode`, () => {
    const theme = shellTheme(appearance, "truecolor");
    // The central rib faces us at zero and faces away half a turn later.
    const centerInk = (index: number): number => {
      // eslint-disable-next-line no-control-regex -- inspect terminal foreground SGRs
      const colors = [...orbFrame(theme, index).matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/gu)];
      return (colors[1]?.slice(1).map(Number) ?? []).reduce((a, b) => a + b, 0);
    };
    expect(appearance === "dark" ? centerInk(0) > centerInk(15) : centerInk(0) < centerInk(15)).toBe(true);
    const frames = orbFrames(theme);
    expect(orbFrames(theme)).toBe(frames);
    const changed = { ...theme, colors: { ...theme.colors,
      warning: { kind: "rgb", r: 220, g: 0, b: 0 } as const,
      muted: { kind: "rgb", r: 220, g: 0, b: 0 } as const,
      text: { kind: "rgb", r: 220, g: 0, b: 0 } as const,
      accent: { kind: "rgb", r: 220, g: 0, b: 0 } as const } };
    expect(orbFrames(changed)).not.toEqual(frames);
    expect(orbFrames(changed).map(stripTerminalSequences)).toEqual(frames.map(stripTerminalSequences));
    for (const role of ["warning", "muted", "text", "accent", "pageBg"] as const) {
      expect(orbFrames({ ...theme, colors: { ...theme.colors, [role]: changed.colors.warning } })).not.toEqual(frames);
    }
    const indexed = orbFrames(shellTheme(appearance, "256color")).join("");
    expect(indexed).toContain("\x1b[38;5;");
    expect(indexed).not.toContain("\x1b[38;2;");
    theme.use(appearance === "dark" ? "light" : "dark");
    expect(orbFrames(theme)).not.toEqual(frames);
  });
}

it("keeps the pose and label column when the shell loader changes work phase", () => {
  vi.useFakeTimers();
  const terminal = new ProcessTerminal();
  vi.spyOn(terminal, "write").mockImplementation(() => undefined);
  const tui = new TuiMainScreen(terminal);
  vi.spyOn(tui, "requestRender").mockImplementation(() => undefined);
  const loader = new Loader(tui, text => text, text => text, "Working…");
  try {
    loader.setIndicator({ frames: orbFrames(shellTheme("dark", "truecolor")), intervalMs: ORB_FRAME_MS });
    vi.advanceTimersByTime(ORB_FRAME_MS * 7);
    const line = () => stripTerminalSequences(loader.render(80).join("\n"));
    const pose = line().slice(0, line().indexOf("Working…"));
    for (const label of ["Verifying…", "Compacting…", "Working…"]) {
      loader.setMessage(label);
      expect(line().slice(0, line().indexOf(label))).toBe(pose);
    }
    vi.advanceTimersByTime(240);
    expect(line().slice(0, line().indexOf("Working…"))).not.toBe(pose);
  } finally { loader.stop(); vi.useRealTimers(); vi.restoreAllMocks(); }
});
