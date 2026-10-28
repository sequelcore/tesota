import { type TranscriptContext, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type xterm from "@xterm/headless";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WELCOME_SCENE_MS } from "../../../src/welcome-header.ts";
import { entryReceipt, isReceipt, receiptStanding } from "../../../src/receipt.ts";
import { peekSessionFile } from "../src/session-file.ts";
import { runApp } from "../src/shell/app.ts";
import type { ScriptStep } from "../tests/engine.ts";
import { scriptedReply } from "../tests/scripted.ts";
import { VirtualTerminal } from "../tests/virtual-terminal.ts";

/**
 * The documentation's images (#468): Tesota's shell as it draws itself,
 * driven in an emulated terminal on a scripted model, and written as SVG in
 * `docs/assets`, light and dark. Run it again when the screen changes:
 * `bun run --cwd packages/core screenshots`. The verified turn runs the
 * fixture's real tests and LemmaScript proofs, so it needs Bun, Git and Dafny.
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
  const replies = script.map(scriptedReply);
  // Verification's model opinions are scripted too, never passed off as proof or live-model judgment.
  const respond = (context: TranscriptContext) => {
    const tool = context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : [])[0]?.name;
    if (tool === "record_open_cases") return fauxAssistantMessage(fauxToolCall(tool, { status: "listed", cases: [] }));
    if (tool === "record_informalizations") return fauxAssistantMessage(fauxToolCall(tool, { informalizations: [{
      function: 1, preconditions: "None.",
      postcondition: "From 100 up subtract 10; below 100 keep the amount.", strength: "strong",
    }] }));
    if (tool === "record_comparisons") return fauxAssistantMessage(fauxToolCall(tool, { comparisons: [{
      function: 1, verdict: "not_justified",
      explanation: "The request takes 10 off orders over 100, so an order of exactly 100 keeps its amount; the contract takes 10 off at 100.",
    }] }));
    const next = replies.shift();
    if (next === undefined || typeof next === "function") throw new Error("Unexpected screenshot model request");
    return next;
  };
  faux.setResponses(Array.from({ length: script.length + 3 }, () => respond));
  models.setProvider(faux.provider);
  const terminal = new VirtualTerminal(100, rows);
  const settingsPath = join(mkdtempSync(join(tmpdir(), "tesota-screenshot-settings-")), "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ permissionMode: "full", model: "scripted/your-model" }));
  const sessions = mkdtempSync(join(tmpdir(), "tesota-screenshot-sessions-"));
  const running = runApp({ cwd, terminal, models, credentials, settingsPath,
    flags: { "open-cases-model": "scripted/your-model" }, sessions });
  await terminal.until("Tesota v");
  if (appearance === "light") {
    // The terminal's answers to the shell's questions about its colors: a light background.
    const asked = (terminal.written.match(/\]11;\?/gu) ?? []).length;
    for (let answer = 0; answer < asked; answer++) {
      terminal.type("\x1b]11;rgb:eded/eded/e5e5\x1b\\");
      terminal.type("\x1b[?62;c");
    }
  }
  return { terminal, running, sessions };
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

const totalBefore = "export function total(amount: number): number {\n  return amount;\n}\n";
// The agent's change misses the request's boundary: "over 100" leaves 100 alone, but the code, its contract and the
// test it wrote all take 10 off at 100. Every check passes; only the request review can notice (#731's spec gap).
const totalAfter = "//@ ensures amount >= 100 ==> \\result === amount - 10\n" +
  "//@ ensures amount < 100 ==> \\result === amount\n" +
  "export function total(amount: number): number {\n  return amount >= 100 ? amount - 10 : amount;\n}\n";
const totalTest = "import { test, expect } from \"bun:test\";\nimport { total } from \"../src/total.ts\";\n\n" +
  "test(\"orders of 100 or more get 10 off\", () => {\n  expect(total(120)).toBe(110);\n  expect(total(100)).toBe(90);\n" +
  "  expect(total(99)).toBe(99);\n  expect(total(0)).toBe(0);\n});\n";

/** A small TypeScript project with a test command: the shell starts ready to run its tests. */
const shop: Readonly<Record<string, string>> = {
  "package.json": `${JSON.stringify({ name: "shop", type: "module", scripts: { test: "bun test" } }, null, 2)}\n`,
  "src/total.ts": totalBefore,
  "test/total-base.test.ts": "import { test } from \"bun:test\";\ntest(\"loads\", async () => { await import(\"../src/total.ts\"); });\n",
};

/**
 * A verified turn whose change misses the request: the request, the agent's change and answer, and Tesota's receipt,
 * its proof and tests passing on the change and its test exercising it, beside the request review's mismatch.
 */
async function turn(appearance: Appearance): Promise<void> {
  const cwd = project(shop);
  const app = await shell(cwd, [{ tool: "write", args: { path: "src/total.ts", content: totalAfter } },
    { tool: "write", args: { path: "test/total.test.ts", content: totalTest } },
    "Orders of 100 or more now get 10 off; the contract and test cover the boundary."], appearance, turnRows);
  app.terminal.type("For nonnegative amounts, take 10 off orders over 100; keep the rest unchanged. Add a contract and test.");
  app.terminal.type(enter);
  await app.terminal.until("✓ Proved", 240_000);
  await app.terminal.until("✓ Tested", 240_000);
  const screen = (await app.terminal.screen()).join("\n");
  const session = readdirSync(app.sessions).find((file) => file.endsWith(".jsonl"));
  const receipt = session === undefined ? undefined : peekSessionFile(join(app.sessions, session)).entries.map(entryReceipt).findLast(isReceipt);
  if (receipt === undefined || receiptStanding(receipt) !== "verified" || !screen.includes("✓ Proved") || !screen.includes("✓ Tested")
    || !screen.includes("failed on the base and passed with the change")
    || receipt.openCases?.status !== "listed" || receipt.openCases.cases.length !== 0
    || !receipt.contracts.some(({ judgment }) => judgment?.verdict === "not_justified") || !screen.includes("does not match")) {
    throw new Error(`The screenshot run did not verify with an exercised test, no open cases and a shown mismatch:\n${screen}`);
  }
  // Independently check the generated proof with the installed CLI, not a scripted proof result.
  const lsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "lsc.exe" : "lsc");
  const proof = spawnSync(lsc, ["check", "--backend=dafny", "src/total.ts"], { cwd, encoding: "utf8" });
  if (proof.status !== 0 || !/finished with [1-9]\d* verified/u.test(proof.stdout + proof.stderr)) {
    throw new Error(`Screenshot proof failed:\n${proof.stdout}${proof.stderr}`);
  }
  console.log(`${appearance}: ${proof.stdout.trim()}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await write(app.terminal, "tesota-turn", appearance, turnRows,
    "A verified turn in Tesota whose change misses the request: the request for 10 off orders over 100, two file writes and the answer, then the receipt card with the proof and tests passing and the new test exercising the change, and apart, a model's opinion that the contract does not match the request at 100.");
  await quit(app);
}

setCapabilityOverrides({ trueColor: true });
mkdirSync(assets, { recursive: true });
for (const appearance of ["dark", "light"] as const) {
  await welcome(appearance);
  await turn(appearance);
}
process.exit(0);
