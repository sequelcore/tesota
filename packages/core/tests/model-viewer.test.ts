import { expect, test } from "bun:test";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
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

test("tabs in a model label keep the canvas and panel divider aligned", async () => {
  const { view } = await viewer();
  const labeled = { ...view, groups: view.groups.map(group => ({ ...group, path: [["pc", "left\tright"]] as const })) };
  const component = new ModelViewer({ theme, subject: "Tabs", rows: () => 30,
    load: async () => labeled, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  const rows = component.render(200).map(terminalText);
  const divider = rows.find(row => row.includes("│ Selected state"))?.indexOf("│ Selected state") ?? -1;
  expect(divider).toBeGreaterThan(0);
  const labels = rows.filter(row => row.includes("left") && row.includes("right") && row.includes("│"));
  expect(labels.length).toBeGreaterThan(0);
  for (const row of labels) {
    expect(row).not.toContain("\t");
    expect(visibleWidth(row.slice(0, row.lastIndexOf("│")))).toBe(divider);
  }
});

test("panning through half a wide canvas cell preserves the box border column", async () => {
  const { view } = await viewer();
  const labeled = { ...view, violations: [], groups: view.groups.map(group => ({ ...group, path: [["pc", "界".repeat(9)]] as const })) };
  const component = new ModelViewer({ theme, subject: "Wide", rows: () => 20,
    load: async () => labeled, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  component.handleInput("f");
  const before = component.render(40).map(terminalText);
  const top = before.findIndex(row => row.includes("┌"));
  const border = visibleWidth((before[top + 1] ?? "").split("│").slice(0, 2).join("│"));
  const mouse = { screenX: 1, screenY: top, width: 40, height: 20, shift: false, alt: false, ctrl: false };
  component.handleMouse({ ...mouse, type: "press", button: "left", x: 1, y: top });
  component.handleMouse({ ...mouse, type: "drag", button: "left", x: -1, y: top });
  component.handleMouse({ ...mouse, type: "release", button: "left", x: -1, y: top });
  const rows = component.render(40).map(terminalText);
  const row = rows[top + 2] ?? "";
  expect(row.startsWith(" ")).toBe(true); // The clipped half of 界 is a blank column.
  expect(row).toContain("界");
  expect(visibleWidth(row.slice(0, row.indexOf("│")))).toBe(border - 2);
  expect((rows[top] ?? "").indexOf("┐")).toBe(border - 2);
  for (const rendered of component.render(40)) expect(visibleWidth(rendered)).toBe(40);
});

test("long labels wrap into two canvas rows before truncating and remain full in the panel", async () => {
  const { view } = await viewer();
  const labeled = { ...view, groups: view.groups.slice(0, 1).map(group => ({ ...group, path: [["door", '"open and waiting for someone"'], ["lamp", '"off"']] as const })) };
  const component = new ModelViewer({ theme, subject: "Wrap", rows: () => 40,
    load: async () => labeled, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  const rows = component.render(160).map(terminalText);
  const boxTop = rows.findIndex(row => row.includes("┌"));
  const labelRows = rows.slice(boxTop + 1, boxTop + 3).map(row => row.split("│")[1]?.trim()).join(" ");
  expect(labelRows).toBe("1. door: open and waiting for someone · lamp: off");
  expect(labelRows).not.toContain("…");
});

test("labels longer than two rows are marked and the full label is reachable in the panel", async () => {
  const { view } = await viewer();
  const words = Array.from({ length: 60 }, (_, i) => `word${String(i).padStart(2, "0")}`);
  const group = view.groups.find(each => each.members.includes(view.violations[0] ?? ""));
  if (group === undefined) throw new Error("Fixture needs a selected group");
  const labeled = { ...view, groups: [{ ...group, path: [["label", `"${words.join(" ")}"`]] as const }] };
  const component = new ModelViewer({ theme, subject: "Long", rows: () => 30,
    load: async () => labeled, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  const rows = component.render(200).map(terminalText);
  const top = rows.findIndex(row => row.includes("┌"));
  const x = (rows[top] ?? "").indexOf("┌"), end = (rows[top] ?? "").indexOf("┐");
  expect(sliceByColumn(rows[top + 1] ?? "", x + 1, end - x - 1)).not.toContain("…");
  expect(sliceByColumn(rows[top + 2] ?? "", x + 1, end - x - 1)).toContain("…");
  const divider = rows.find(row => row.includes("│ Selected state"))?.indexOf("│ Selected state") ?? -1;
  expect(divider).toBeGreaterThan(0);
  let panel = "";
  for (let page = 0; page < 15; page++) {
    panel += component.render(200).map(terminalText).map(row => sliceByColumn(row, divider + 1, 200 - divider - 1)).join("\n");
    component.handleInput("\x1b[6~");
  }
  for (const word of words) expect(panel).toContain(word);
});

test("four groups center in a large canvas and f restores the centered frame after panning", async () => {
  const { view } = await viewer();
  const component = new ModelViewer({ theme, subject: "Center", rows: () => 70,
    load: async () => view, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  const rows = component.render(240).map(terminalText);
  const divider = rows.find(row => row.includes("│ Selected state"))?.indexOf("│") ?? -1;
  const tops = rows.flatMap((row, y) => [...row.slice(0, divider).matchAll(/┌/gu)].map(match => ({ x: match.index, y })));
  const bottoms = rows.flatMap((row, y) => [...row.slice(0, divider).matchAll(/┘/gu)].map(match => ({ x: match.index, y })));
  expect(tops).toHaveLength(4);
  expect(Math.min(...tops.map(p => p.x))).toBeGreaterThan(10);
  expect(Math.abs(Math.min(...tops.map(p => p.x)) - (divider - 1 - Math.max(...bottoms.map(p => p.x))))).toBeLessThanOrEqual(1);
  const headerEnd = rows.findIndex(row => row.includes("Selected state"));
  const keys = rows.length - 2;
  expect(Math.abs((Math.min(...tops.map(p => p.y)) - headerEnd) - (keys - Math.max(...bottoms.map(p => p.y))))).toBeLessThanOrEqual(1);
  component.handleInput("\x1b[C"); component.handleInput("\x1b[B");
  component.render(80);
  component.handleInput("f");
  expect(component.render(240).map(terminalText)).toEqual(rows);
});

test("selected state shows the model rule verbatim through terminal sanitization", async () => {
  const data = JSON.parse(readFileSync(fixture, "utf8"));
  const definition = 'door = "locked" => lamp = "off" /\\ x = "</script>"';
  data.binding = { modelHash: "bound" };
  data.ruleDefinitions = { modelHash: "bound", properties: { DarkWhenLocked: definition } };
  const { component } = await viewer(JSON.stringify(data));
  const text = screen(component, 180);
  expect(text).toContain("Rule, from the model:");
  expect(text).toContain('door = "locked" => lamp = "off"');
  expect(text).toContain('x =');
  expect(text).toContain('"</script>"');
  expect(text.slice(0, text.indexOf("Selected state"))).toContain('door = "locked" => lamp = "off"');
});

test("uses page wording, a selected-state title and a secondary TLC id without inventing a rule", async () => {
  const { component } = await viewer();
  const text = screen(component, 200);
  expect(text).toContain("Selected state");
  expect(text).toContain("TLC id ");
  expect(text).not.toMatch(/State -?\d/u);
  expect(text).toContain("door: locked");
  expect(text).toContain("≥1 state");
  expect(text).toContain("⚠ breaks DarkWhenLocked");
  expect(text).not.toContain("Rule, from the model:");
  expect(text).toContain("Partial exploration: counts are at least these numbers");
  expect(text).toContain("Arrows between groups are possible moves, not one run. t shows the failing run, a real execution.");
  for (const width of [40, 80, 100, 200]) {
    const keys = component.render(width).map(terminalText).at(-1) ?? "";
    expect(keys).toContain("o browser");
    expect(keys).toContain("Esc back");
    expect(keys).toContain("f fit");
    expect(visibleWidth(keys)).toBeLessThanOrEqual(width);
  }
});

test("the header shows every captured broken rule and does not promise an absent trace", async () => {
  const { view } = await viewer();
  const altered = { ...view, trace: [], states: view.states.map((state, i) => ({ ...state, breaks: [i === 0 ? "First" : "Second"] })), ruleDefinitions: { First: "first rule text", Second: "second rule text" } };
  const component = new ModelViewer({ theme, subject: "Rules", rows: () => 30,
    load: async () => altered, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  const text = screen(component, 200).split("Selected state")[0] ?? "";
  expect(text).toContain("Rule, from the model: first rule text");
  expect(text).toContain("Rule, from the model: second rule text");
  expect(text).not.toContain("t shows the failing run");
});

test("the key bar survives a wrapped header at the minimum terminal size", async () => {
  const { view } = await viewer();
  const component = new ModelViewer({ theme, subject: "Lights", rows: () => 12,
    load: async () => view, close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  const rows = component.render(40).map(terminalText);
  expect(rows).toHaveLength(12);
  expect(rows.at(-1)).toContain("o browser");
  expect(rows.at(-1)).toContain("Esc back");
});

test("f resets a genuinely panned drawing", async () => {
  const { component } = await viewer();
  component.handleInput("f");
  const before = component.render(100).map(terminalText);
  component.handleInput("\x1b[C");
  const panned = component.render(100).map(terminalText);
  expect(panned).not.toEqual(before);
  expect(panned.at(-1)).toContain("pan 8,0");
  component.handleInput("f");
  expect(component.render(100).map(terminalText)).toEqual(before);
});

test("o keeps a long written path copyable at an 80-column width", async () => {
  const view = await captured();
  const path = 'C:\\sessions\\' + 'a'.repeat(160) + '.html';
  const component = new ModelViewer({ theme, subject: "Lights", rows: () => 20,
    load: async () => view, browser: async (_signal, written) => { written(path); },
    close: () => undefined, redraw: () => undefined });
  await Promise.resolve();
  component.handleInput("o");
  await Promise.resolve();
  const rows = component.render(80).map(terminalText);
  expect(rows.slice(-4, -1).map(row => row.trim()).join("")).toBe(path);
  expect(rows.at(-1)).toContain("o browser");
});
