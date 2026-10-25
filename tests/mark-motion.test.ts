import { expect, it } from "vitest";
import { WelcomeHeader, mountWelcomeHeader } from "../src/welcome-header.js";
import { shellTheme } from "../src/theme.js";

it("stops opening motion on work, never animates during work or restarts on completion", () => {
  let now = 0;
  let working = false;
  const callbacks = new Set<() => void>();
  const view = new WelcomeHeader("shop", shellTheme("dark", "truecolor"), {
    terminalRows: () => 40, stageShare: 0.5, now: () => now, working: () => working,
    requestRender: () => undefined,
    setTimer: (callback) => { callbacks.add(callback); return () => { callbacks.delete(callback); }; },
  });
  view.render(100); expect(callbacks.size).toBe(1);
  working = true; now = 100; view.render(100);
  expect(callbacks.size).toBe(0); expect(view.moving).toBe(false);
  expect(view.clickHeader({ type: "click", button: "left", x: 5, y: 1, shift: false, ctrl: false, alt: false } as never)).toBeUndefined();
  working = false; now = 200;
  const staticFrame = view.render(100);
  expect(view.moving).toBe(false); expect(callbacks.size).toBe(0);
  now = 400; expect(view.render(100)).toEqual(staticFrame);
});

it("routes header mark clicks through the mounted MouseRegion after the splash is gone", () => {
  let now = 0;
  const view = new WelcomeHeader("shop", shellTheme("dark", "256color"), {
    terminalRows: () => 40, stageShare: 0.5, now: () => now,
    requestRender: () => undefined, setTimer: () => () => undefined,
  });
  const mounted = mountWelcomeHeader(view, { requestRender: () => undefined,
    queryTerminalColors: () => Promise.resolve({}), onTerminalColorSchemeChange: () => () => undefined });
  const first = mounted.render(100);
  now = 800; mounted.render(100); expect(view.moving).toBe(false);
  mounted.emptyState.pause();
  const event = { type: "click", button: "left", x: 5, y: 1, shift: false, ctrl: false, alt: false } as const;
  expect(mounted.handleMouse?.(event as never)).toEqual({ handled: true, render: true });
  mounted.render(100); now += 200;
  expect(mounted.render(100)).not.toEqual(first);
  now += 600; expect(mounted.render(100)).toEqual(first);
  mounted.dispose();
});
