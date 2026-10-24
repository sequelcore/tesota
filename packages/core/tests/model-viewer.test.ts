import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOnlyText, ModelViewer } from "../src/shell/model-viewer.ts";
import { loadModelView } from "../../../src/model-view-process.ts";
import { shellTheme } from "../../../src/theme.ts";
import { terminalText } from "../../../src/terminal-text.ts";

const fixture = join(import.meta.dir, "fixtures/model-viewer/lights-partial.manifest.json");
const theme = shellTheme("dark", "truecolor");
async function captured(source = readFileSync(fixture, "utf8")) {
  const path = join(mkdtempSync(join(tmpdir(), "tesota-viewer-text-")), "capture.manifest.json");
  copyFileSync(fixture.replace(".manifest.json", ".dot"), join(path, "..", "lights-partial.dot"));
  writeFileSync(path, source);
  return loadModelView(path, {}, new AbortController().signal);
}
async function viewer(source?: string) {
  const view = await captured(source);
  const component = new ModelViewer({ theme, subject: "Lights", rows: () => 20,
    load: async () => view, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  return { view, component };
}
const screen = (component: ModelViewer, width = 100) => component.render(width).map(terminalText).join("\n");

test("manifest violation names are sanitized in the panel, trace and jump notice", async () => {
  const name = "Bad\x1b[2J\x07Name";
  const source = readFileSync(fixture, "utf8").replaceAll("DarkWhenLocked", JSON.stringify(name).slice(1, -1));
  const { component } = await viewer(source);
  expect(screen(component)).toContain("Bad�Name");
  component.handleInput("t");
  expect(screen(component)).toContain("Bad�Name");
  component.handleInput("n");
  expect(screen(component)).toContain("Bad�Name");
  // Inspect raw output too: stripping the test output must not hide an injected control.
  expect(component.render(100).join("\n")).not.toContain("\x1b[2J");
  expect(component.render(100).join("\n")).not.toContain("\x07");
});

test("append-only overflow notices sanitize the manifest path", async () => {
  const { view } = await viewer();
  const text = appendOnlyText(view, "capture\x1b[2J\x07.json", 0);
  expect(text).toContain("capture�.json");
  expect(text).not.toContain("\x1b");
  expect(text).not.toContain("\x07");
});

test("full-width variables remain reachable through panel scrolling", async () => {
  const { view } = await viewer();
  const value = Array.from({ length: 180 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
  const selected = view.violations[0];
  const wide = { ...view, states: view.states.map(state => state.fingerprint === selected ? { ...state, valuation: `wide = ${value}` } : state) };
  const component = new ModelViewer({ theme, subject: "Wide", rows: () => 20,
    load: async () => wide, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  let reached = "";
  for (let page = 0; page < 10; page++) {
    reached += screen(component, 80);
    component.handleInput("\x1b[6~");
  }
  for (const character of value) expect(reached).toContain(character);
});

test("canvas cells preserve graphemes alongside full-width text", async () => {
  const { view } = await viewer();
  const labeled = { ...view, groups: view.groups.map(group => ({ ...group, path: [["pc", "界e\u0301界"]] as const })) };
  const component = new ModelViewer({ theme, subject: "Wide", rows: () => 20,
    load: async () => labeled, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  expect(screen(component)).toContain("界e\u0301界");
});

test("panning through half a wide canvas cell preserves the box border column", async () => {
  const { view } = await viewer();
  const labeled = { ...view, violations: [], groups: view.groups.map(group => ({ ...group, path: [["pc", "界".repeat(9)]] as const })) };
  const component = new ModelViewer({ theme, subject: "Wide", rows: () => 20,
    load: async () => labeled, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  component.render(40);
  component.handleInput("\x1b[C");
  component.handleInput("\x1b[C");
  const row = terminalText(component.render(40)[4] ?? "");
  expect(visibleWidth(row.slice(0, row.indexOf("│")))).toBe(7);
});
