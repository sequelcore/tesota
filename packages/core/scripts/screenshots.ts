import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type xterm from "@xterm/headless";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WELCOME_SCENE_MS } from "../../../src/welcome-header.ts";
import { runApp } from "../src/shell/app.ts";
import type { ScriptStep } from "../tests/engine.ts";
import { scriptedReply } from "../tests/scripted.ts";
import { VirtualTerminal } from "../tests/virtual-terminal.ts";

/**
 * The documentation's images (#468): Tesota's shell as it draws itself,
 * driven in an emulated terminal on a scripted model, and written as SVG in
 * `docs/assets`, light and dark. Run it again when the screen changes:
 * `bun run --cwd packages/core screenshots`. The verified turn runs the
 * project's own tests, so it needs Node and Git.
 */
const root = join(import.meta.dir, "..", "..", "..");
/** The home folder the shell runs in, a new temporary one, which the footer and header show as `~`. */
const home = mkdtempSync(join(tmpdir(), "tesota-screenshot-home-"));
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
const assets = join(root, "docs", "assets");
const enter = "\r";
type Appearance = "dark" | "light";

interface Palette { readonly background: string; readonly foreground: string; readonly ansi: readonly string[] }

/** The terminal's own colors for an appearance: Tesota's terminal scheme, whose canvas the themes are drawn for. */
function palette(appearance: Appearance): Palette {
  const schemes = (JSON.parse(readFileSync(join(root, "terminal-schemes", "windows-terminal", "tesota.json"), "utf8")) as
    { schemes: Record<string, string>[] }).schemes;
  const scheme = schemes.find((each) => each["name"] === (appearance === "dark" ? "Tesota Dark" : "Tesota Light")) ?? {};
  const names = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white"];
  const ansi = [...names, ...names.map((name) => `bright${name[0]?.toUpperCase() ?? ""}${name.slice(1)}`)].map((name) => scheme[name] ?? "#808080");
  return { background: scheme["background"] ?? "#202020", foreground: scheme["foreground"] ?? "#f2eee6", ansi };
}

const hex = (rgb: number): string => `#${rgb.toString(16).padStart(6, "0")}`;

/** One of the 256 indexed colors: the scheme's sixteen, then xterm's cube and grays. */
function indexed(index: number, colors: Palette): string {
  if (index < 16) return colors.ansi[index] ?? colors.foreground;
  if (index >= 232) return hex(((8 + (index - 232) * 10) * 0x010101));
  const cube = index - 16;
  const level = (step: number): number => step === 0 ? 0 : 55 + step * 40;
  return hex((level(Math.floor(cube / 36)) << 16) | (level(Math.floor(cube / 6) % 6) << 8) | level(cube % 6));
}

const escapeXml = (text: string): string => text.replace(/[&<>"]/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char] ?? char);

/** How a cell is drawn: its text and background colors, inverse applied, and whether it is bold. */
interface Style { readonly fg: string; readonly bg: string | undefined; readonly bold: boolean }

/** A cell's text or background color, as the terminal was told it; undefined for the terminal's own. */
function colorOf(mode: "fg" | "bg", cell: xterm.IBufferCell, colors: Palette): string | undefined {
  const rgb = mode === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  const palettes = mode === "fg" ? cell.isFgPalette() : cell.isBgPalette();
  const value = mode === "fg" ? cell.getFgColor() : cell.getBgColor();
  if (rgb) return hex(value);
  return palettes ? indexed(value, colors) : undefined;
}

function styleOf(cell: xterm.IBufferCell, colors: Palette): Style {
  const inverse = cell.isInverse() !== 0;
  return { fg: inverse ? colorOf("bg", cell, colors) ?? colors.background : colorOf("fg", cell, colors) ?? colors.foreground,
    bg: inverse ? colorOf("fg", cell, colors) ?? colors.foreground : colorOf("bg", cell, colors), bold: cell.isBold() !== 0 };
}

const sameStyle = (one: Style, other: Style): boolean => one.fg === other.fg && one.bg === other.bg && one.bold === other.bold;

/** The run of cells from `column` in one style: its text and how many cells it takes. */
function runAt(line: xterm.IBufferLine, column: number, columns: number, colors: Palette, scratch: xterm.IBufferCell):
  { readonly style: Style; readonly text: string; readonly span: number } | undefined {
  const first = line.getCell(column, scratch);
  if (first === undefined) return undefined;
  const style = styleOf(first, colors);
  let text = "";
  let span = 0;
  for (let next = column; next < columns; next++) {
    const each = line.getCell(next, scratch);
    if (each === undefined || !sameStyle(styleOf(each, colors), style)) break;
    if (each.getWidth() === 0) continue;
    text += each.getChars() || " ";
    span += each.getWidth();
  }
  return { style, text, span };
}

const cell = { width: 8.4, height: 18 };
const pad = 16;

/** A run's background, and each of its words at its own cells, stretched to them, so a font's other widths never move what follows. */
function drawRun(run: { readonly style: Style; readonly text: string; readonly span: number }, x: number, y: number): { shapes: string[]; texts: string[] } {
  const shapes = run.style.bg === undefined ? []
    : [`<rect x="${x.toFixed(1)}" y="${y}" width="${(run.span * cell.width).toFixed(1)}" height="${cell.height}" fill="${run.style.bg}"/>`];
  const texts = [...run.text.matchAll(/\S+/gu)].map((word) => {
    const at = x + Array.from(run.text.slice(0, word.index)).length * cell.width;
    const cells = Array.from(word[0]).length * cell.width;
    return `<text x="${at.toFixed(1)}" y="${y + 13}" fill="${run.style.fg}"${run.style.bold ? " font-weight=\"bold\"" : ""} ` +
      `textLength="${cells.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${escapeXml(word[0])}</text>`;
  });
  return { shapes, texts };
}

/** The screen as SVG: each run of one background a rectangle, and its words on it. */
function svg(buffer: xterm.IBuffer, columns: number, rows: number, colors: Palette, title: string): string {
  const width = Math.round(columns * cell.width + pad * 2);
  const height = Math.round(rows * cell.height + pad * 2);
  const shapes: string[] = [];
  const texts: string[] = [];
  const scratch = buffer.getNullCell();
  for (let row = 0; row < rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    for (let column = 0; line !== undefined && column < columns;) {
      const run = runAt(line, column, columns, colors, scratch);
      if (run === undefined) break;
      if (run.span === 0) { column++; continue; }
      const drawn = drawRun(run, pad + column * cell.width, pad + row * cell.height);
      shapes.push(...drawn.shapes);
      texts.push(...drawn.texts);
      column += run.span;
    }
  }
  return [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${width}" height="${height}" rx="10" fill="${colors.background}"/>`,
    ...shapes,
    `<g font-family="'Cascadia Mono', 'JetBrains Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace" font-size="14" xml:space="preserve">`,
    ...texts, "</g>", "</svg>", ""].join("\n");
}

/**
 * A Git repository named `shop` with `files` committed, in the home folder
 * the shell is given (`home`), so the images show `~/shop` and nothing of
 * the machine's folders.
 */
function project(files: Readonly<Record<string, string>>): string {
  const cwd = join(home, "shop");
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), content);
  }
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]]) {
    spawnSync("git", args, { cwd });
  }
  return cwd;
}

/** The shell in `cwd` on a scripted model, chosen in its settings, in full access, drawn on a light or dark terminal. */
async function shell(cwd: string, script: readonly ScriptStep[], appearance: Appearance, rows: number) {
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  // A scripted model, named as no real one is, which the footer shows.
  const faux = fauxProvider({ tokensPerSecond: 400, provider: "scripted", models: [{ id: "your-model" }] });
  faux.setResponses(script.map(scriptedReply));
  models.setProvider(faux.provider);
  const terminal = new VirtualTerminal(100, rows);
  const settingsPath = join(mkdtempSync(join(tmpdir(), "tesota-screenshot-settings-")), "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ permissionMode: "full", model: "scripted/your-model" }));
  const running = runApp({ cwd, terminal, models, credentials, settingsPath, sessions: mkdtempSync(join(tmpdir(), "tesota-screenshot-sessions-")) });
  await terminal.until("Tesota v");
  if (appearance === "light") {
    // The terminal's answers to the shell's questions about its colors: a light background.
    const asked = (terminal.written.match(/\]11;\?/gu) ?? []).length;
    for (let answer = 0; answer < asked; answer++) {
      terminal.type("\x1b]11;rgb:eded/eded/e5e5\x1b\\");
      terminal.type("\x1b[?62;c");
    }
  }
  return { terminal, running };
}

const quit = async ({ terminal, running }: { terminal: VirtualTerminal; running: Promise<void> }): Promise<void> => {
  terminal.type("\x1b[99;5u");
  terminal.type("/quit");
  terminal.type(enter);
  await running;
};

const write = async (terminal: VirtualTerminal, name: string, appearance: Appearance, rows: number, title: string): Promise<void> => {
  writeFileSync(join(assets, `${name}-${appearance}.svg`), svg(await terminal.drawn(), 100, rows, palette(appearance), title));
};

const welcomeRows = 30;
const turnRows = 40;

/** The shell as it opens: compact header, faint centered palo fierro, input band and footer. */
async function welcome(appearance: Appearance): Promise<void> {
  const app = await shell(project(shop), [], appearance, welcomeRows);
  // The sub-second rustle ends at the exact static grid, still at 30% opacity.
  await new Promise((resolve) => setTimeout(resolve, WELCOME_SCENE_MS + 1000));
  await write(app.terminal, "tesota-welcome", appearance, welcomeRows,
    "Tesota's shell as it opens: a pixel ironwood beside the name, model, folder and purpose, a 30%-opacity ironwood and armless seedling in the empty space, then the input band and footer.");
  await quit(app);
}

const totalBefore = "export const total = (prices) => prices.reduce((sum, price) => sum + price, 0);\n";
const totalAfter = "export const total = (prices) => {\n  const sum = prices.reduce((all, price) => all + price, 0);\n" +
  "  return sum > 100 ? sum * 0.9 : sum;\n};\n";
const totalTest = "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { total } from \"../src/total.mjs\";\n\n" +
  "test(\"orders over 100 get 10% off\", () => {\n  assert.equal(total([80, 40]), 108);\n  assert.equal(total([60, 40]), 100);\n});\n";

/** A small JavaScript project with a test command: the shell starts ready to run its tests. */
const shop: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify({ name: "shop", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/total.mjs": totalBefore,
  "test/total-base.test.mjs": "import { test } from \"node:test\";\ntest(\"loads\", async () => { await import(\"../src/total.mjs\"); });\n",
};

/** A verified turn: the request, the agent's change and answer, and Tesota's receipt, its tests run on the change and on the base. */
async function turn(appearance: Appearance): Promise<void> {
  const app = await shell(project(shop), [{ tool: "write", args: { path: "src/total.mjs", content: totalAfter } },
    { tool: "write", args: { path: "test/total.test.mjs", content: totalTest } },
    "Orders over 100 now get 10% off, and test/total.test.mjs checks both sides of 100."], appearance, turnRows);
  app.terminal.type("Take 10% off orders over 100, and add a test for it.");
  app.terminal.type(enter);
  await app.terminal.until("receipt ·", 120_000);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await write(app.terminal, "tesota-turn", appearance, turnRows,
    "A verified turn in Tesota: a blooming pixel ironwood in the header, the request, two file writes and the answer, then the receipt card with the passing tests and the new test exercising the change.");
  await quit(app);
}

setCapabilityOverrides({ trueColor: true });
mkdirSync(assets, { recursive: true });
for (const appearance of ["dark", "light"] as const) {
  await welcome(appearance);
  await turn(appearance);
}
process.exit(0);
