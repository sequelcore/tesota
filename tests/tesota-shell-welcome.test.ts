import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { expect, it } from "vitest";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";
import { TESOTA_LOGOS, TESOTA_LOGO_TONES, TESOTA_WELCOME_FRAMES, WelcomeBanner, welcomeColorMode }
  from "../src/tesota-shell-welcome.js";

it("keeps every logo and animation frame within its fixed ASCII rectangle", () => {
  const sizes = { main: [34, 12], compact: [16, 6], symbol: [5, 3] } as const;
  const allowed = new Set(" /\\|_.-'()");
  for (const [name, [width, height]] of Object.entries(sizes)) {
    const rows = TESOTA_LOGOS[name as keyof typeof TESOTA_LOGOS];
    const tones = TESOTA_LOGO_TONES[name as keyof typeof TESOTA_LOGO_TONES];
    expect(rows).toHaveLength(height);
    expect(tones).toHaveLength(height);
    for (const [index, row] of rows.entries()) {
      expect(row).toHaveLength(width);
      for (const character of row) expect(allowed.has(character)).toBe(true);
      expect(tones[index]).toHaveLength(width);
      for (let column = 0; column < width; column++) {
        expect(tones[index]?.[column] === " ").toBe(row[column] === " ");
        expect(tones[index]?.[column]).toMatch(/^[123 ]$/u);
      }
    }
  }
  expect(TESOTA_WELCOME_FRAMES).toHaveLength(5);
  for (const frame of TESOTA_WELCOME_FRAMES) {
    expect(frame).toHaveLength(12);
    for (const row of frame) {
      expect(row).toHaveLength(34);
      for (const character of row) expect(allowed.has(character)).toBe(true);
    }
  }
  expect(TESOTA_WELCOME_FRAMES.at(-1)).toEqual(TESOTA_LOGOS.main);
});

it("shows the final art without movement when requested and scales down without clipping", () => {
  const banner = new WelcomeBanner("C:\\work\\tesota", tesotaShellTheme("terminal"), () => 40,
    { reducedMotion: true, colorMode: "plain" });
  expect(banner.render(80)).toContain(TESOTA_LOGOS.main[0]);
  expect(banner.advance()).toBe(false);
  expect(banner.render(20)).toContain(TESOTA_LOGOS.compact[0]);
  expect(banner.render(10)).toContain(TESOTA_LOGOS.symbol[0]);
  expect(banner.render(4).every((line) => stripTerminalSequences(line).length <= 4)).toBe(true);
});

it("grows through the five frames and settles on the complete tree", () => {
  const banner = new WelcomeBanner("work", tesotaShellTheme("terminal"), () => 40,
    { colorMode: "plain" });
  for (const frame of TESOTA_WELCOME_FRAMES) {
    expect(banner.render(80).slice(-12)).toEqual(frame);
    expect(banner.advance()).toBe(frame !== TESOTA_WELCOME_FRAMES.at(-1));
  }
});

it("uses the corrected light shadow and 256-color fallbacks", () => {
  const dark = new WelcomeBanner("work", tesotaShellTheme("tesota-dark"), () => 40,
    { reducedMotion: true, colorMode: "ansi256" });
  const light = new WelcomeBanner("work", tesotaShellTheme("tesota-light"), () => 40,
    { reducedMotion: true, colorMode: "ansi256" });
  expect(dark.render(80).join("\n")).toContain("\x1b[38;5;244m");
  expect(light.render(80).join("\n")).toContain("\x1b[38;5;242m");
  const lightRgb = new WelcomeBanner("work", tesotaShellTheme("tesota-light"), () => 40,
    { reducedMotion: true, colorMode: "truecolor" });
  expect(lightRgb.render(80).join("\n")).toContain("\x1b[38;2;101;112;95m");
  expect(welcomeColorMode({ TERM: "dumb" })).toBe("plain");
  expect(welcomeColorMode({ TERM: "xterm-256color" })).toBe("ansi256");
});
