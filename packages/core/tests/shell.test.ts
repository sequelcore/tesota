import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Editor, type SlashCommand } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiMode } from "../src/settings.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import { type Shell, startShell } from "../src/shell/shell.ts";
import { createSurface, type Surface } from "../src/shell/surface.ts";
import { shellTheme } from "../../../src/theme.ts";
import type { ScriptStep } from "./engine.ts";
import { accepts, scriptedReply } from "./scripted.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * The engine's shell (#444), drawn into an emulated terminal: what the
 * operator sees, typing as they would, in both modes.
 */
const open: { session: EngineSession; shell: Shell }[] = [];
afterEach(async () => {
  for (const { session, shell } of open.splice(0)) {
    shell.stop();
    await session.dispose();
  }
});

const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const enter = "\r";

function shellOn(script: readonly ScriptStep[], mode: TuiMode = "fullscreen", size: [number, number] = [80, 24],
  extra: { tokensPerSecond?: number; copy?: (text: string) => Promise<boolean>; commands?: readonly SlashCommand[]; surface?: Surface } = {}) {
  const faux = fauxProvider({ tokensPerSecond: extra.tokensPerSecond ?? 400 });
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd: folder("tesota-core-shell-"), folder: folder("tesota-core-sessions-"), models,
    model: faux.getModel(), verifier: accepts });
  const terminal = new VirtualTerminal(...size);
  const shell = startShell({ terminal, mode, fullRepaint: false, theme: shellTheme("dark", "truecolor"), session,
    status: () => "scripted model", ...extra });
  open.push({ session, shell });
  return { terminal, session, shell };
}

/** Waits until `session`'s run has ended. */
async function settled(session: EngineSession): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = session.subscribe((event) => { if (event.type === "ended") { stop(); resolve(); } });
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

const shown = (lines: readonly string[]): string => lines.join("\n");

describe("the shell", () => {
  test("slash suggestions stay on the mounted editor when a surface replaces it", async () => {
    const surface = createSurface(shellTheme("dark", "truecolor"));
    const { terminal } = shellOn([], "fullscreen", [80, 24], { surface,
      commands: [{ name: "resume", description: "Open an earlier session" }] });
    terminal.type("/");
    expect(await terminal.until("Open an earlier session")).toMatch(/resume\s+Open an earlier session/u);
    terminal.type("\t");
    expect(await terminal.untilGone("Open an earlier session")).toContain("/resume");
    surface.ui.setEditorComponent((tui, theme) => new Editor(tui, theme));
    expect((await terminal.screen()).join("\n")).toContain("/resume");
    terminal.type("\x03");
    terminal.type("/");
    await terminal.until("Open an earlier session");
    terminal.type("\t");
    await terminal.untilGone("Open an earlier session");
    surface.ui.setEditorComponent(undefined);
    terminal.type("\x03");
    terminal.type("/");
    expect(await terminal.until("Open an earlier session")).toMatch(/resume\s+Open an earlier session/u);
  });

  test("@ suggests files in the shown session's folder, including after switching sessions", async () => {
    const first = shellOn([]);
    const second = shellOn([]);
    writeFileSync(join(first.session.workspace.cwd, "first-notes.md"), "first\n");
    writeFileSync(join(second.session.workspace.cwd, "second-notes.md"), "second\n");
    first.terminal.type("@first-n");
    expect(await first.terminal.until("first-notes.md")).toContain("@first-n");
    first.terminal.type("\t");
    await first.terminal.until("@first-notes.md");
    first.shell.show(second.session);
    first.terminal.type("@second-n");
    expect(await first.terminal.until("second-notes.md")).not.toContain("first-notes.md");
    first.terminal.type("\t");
    await first.terminal.until("@second-notes.md");
    first.shell.show(first.session);
    expect(await first.terminal.until("@first-notes.md")).not.toContain("second-notes.md");
    first.terminal.type("\x03");
    first.terminal.type("@first-n");
    expect(await first.terminal.until("first-notes.md")).not.toContain("second-notes.md");
  });

  test("a request typed and sent shows with its answer, the editor below and the footer last", async () => {
    const { terminal, session } = shellOn(["Hello from the engine."]);
    terminal.type("hi there");
    terminal.type(enter);
    await settled(session);
    const screen = await terminal.screen();
    expect(shown(screen)).toContain("hi there");
    expect(shown(screen)).toContain("Hello from the engine.");
    expect(screen.findLastIndex((line) => line.includes("scripted model"))).toBeGreaterThan(
      screen.findIndex((line) => line.includes("Hello from the engine.")));
  });

  test("an operator message has a dim prompt, aligned continuation and no background", async () => {
    const { terminal, session } = shellOn(["answered"]);
    terminal.type("\x1b[200~first line\nsecond line\x1b[201~");
    terminal.type(enter);
    await settled(session);
    const screen = await terminal.screen();
    const row = screen.findIndex((line) => line.includes("first line"));
    expect(screen.slice(row, row + 2).map((line) => line.trimEnd())).toEqual(["› first line", "  second line"]);
    const buffer = await terminal.drawn();
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(0)?.getFgColor()).toBe(0x8f8d84);
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(2)?.getFgColor()).toBe(0xf2eee6);
    for (let line = row; line < row + 2; line++) {
      for (let column = 0; column < terminal.columns; column++) {
        expect(buffer.getLine(buffer.viewportY + line)?.getCell(column)?.isBgDefault()).toBe(true);
      }
    }
  });

  for (const mode of ["fullscreen", "inline"] as const) test(`a write is one unfilled row until Ctrl+O expands it, and folds again (${mode})`, async () => {
    const { terminal, session } = shellOn([{ tool: "write", args: { path: "a.txt", content: "one\n" } }, "done"], mode);
    terminal.type("write it");
    terminal.type(enter);
    await settled(session);
    const screen = await terminal.screen();
    const row = screen.findIndex((line) => line.includes("write a.txt"));
    expect(screen[row]).toBe("✓ write a.txt");
    expect(screen[row + 1]).toBe("");
    expect(shown(screen)).not.toContain("Wrote");
    const buffer = await terminal.drawn();
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(0)?.getFgColor()).toBe(0xb9b7aa);
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(2)?.isBold()).toBeGreaterThan(0);
    for (let column = 0; column < terminal.columns; column++) {
      expect(buffer.getLine(buffer.viewportY + row)?.getCell(column)?.isBgDefault()).toBe(true);
    }
    terminal.type("\x0f");
    const expanded = await terminal.until("Wrote 4 bytes to a.txt.");
    expect(expanded.split("\n").map((line) => line.trimEnd()).join("\n")).toContain("✓ write a.txt\n  Wrote 4 bytes to a.txt.");
    terminal.type("\x0f");
    expect(await terminal.untilGone("Wrote 4 bytes")).toContain("✓ write a.txt");
  });

  test("an edit shows replacement counts collapsed and its diff after Ctrl+O", async () => {
    const { terminal, session } = shellOn([
      { tool: "write", args: { path: "a.txt", content: "one\ntwo\n" } },
      { tool: "edit", args: { path: "a.txt", edits: [{ oldText: "one", newText: "first\nsecond" }, { oldText: "two", newText: "third" }] } },
      "done"], "fullscreen", [80, 36]);
    terminal.type("change it");
    terminal.type(enter);
    await settled(session);
    const screen = shown(await terminal.screen());
    expect(screen).toContain("✓ edit a.txt +3 −2");
    expect(screen).not.toContain("- one");
    expect(screen).not.toContain("+ first");
    terminal.type("\x0f");
    const expanded = await terminal.until("+ third");
    expect(expanded.split("\n").map((line) => line.trimEnd()).join("\n")).toContain("✓ edit a.txt +3 −2\n  - one\n  + first\n  + second\n  - two\n  + third");
    terminal.type("\x0f");
    expect(await terminal.untilGone("+ third")).toContain("✓ edit a.txt +3 −2");
  });

  test("a failed call keeps its reason visible while collapsed", async () => {
    const { terminal, session } = shellOn([
      { tool: "write", args: { path: "a.txt", content: "one\n" } },
      { tool: "read", args: { path: "a.txt", offset: 99 } }, "done"], "fullscreen", [80, 32]);
    terminal.type("read past the end");
    terminal.type(enter);
    await settled(session);
    const screen = shown(await terminal.screen());
    expect(screen).toContain("✗ read a.txt\n  Offset 99 is past the end of the file, which has 1 lines.");
  });

  test("ending a fullscreen shell leaves the conversation in the terminal's scrollback", async () => {
    const { terminal, session, shell } = shellOn(["An answer worth keeping."]);
    terminal.type("keep this");
    terminal.type(enter);
    await settled(session);
    terminal.type("\x04");
    await shell.stopped;
    const kept = shown(await terminal.scrollback());
    expect(kept).toContain("keep this");
    expect(kept).toContain("An answer worth keeping.");
  });

  test("inline, the conversation prints into the scrollback as it goes", async () => {
    const { terminal, session } = shellOn(["Printed inline."], "inline");
    terminal.type("inline please");
    terminal.type(enter);
    await settled(session);
    expect(shown(await terminal.scrollback())).toContain("Printed inline.");
    expect(terminal.written).not.toContain("\x1b[?1049h");
  });

  test("Esc stops a run as it streams, and the shell says so", async () => {
    const { terminal, session } = shellOn(["a long answer that streams slowly enough to be stopped part of the way through it"], "fullscreen",
      [80, 24], { tokensPerSecond: 10 });
    terminal.type("go");
    terminal.type(enter);
    await terminal.until("Working");
    terminal.type("\x1b");
    await settled(session);
    expect(await terminal.until("The run ended aborted.")).toContain("The run ended aborted.");
  });

  test("Enter while the agent works steers it, and Alt+Enter queues a follow-up, both answered before the run ends", async () => {
    const { terminal, session } = shellOn(["a first answer that streams slowly enough to be steered", "answering both"],
      "fullscreen", [100, 40], { tokensPerSecond: 20 });
    terminal.type("go");
    terminal.type(enter);
    await terminal.until("Working");
    terminal.type("also this");
    terminal.type(enter);
    terminal.type("then that");
    // Alt+Enter, as a terminal with the kitty keyboard protocol sends it.
    terminal.type("\x1b[13;3u");
    await settled(session);
    const screen = await terminal.until("answering both");
    expect(screen.indexOf("also this")).toBeLessThan(screen.indexOf("answering both"));
    expect(screen.indexOf("then that")).toBeLessThan(screen.indexOf("answering both"));
    expect(session.ledger()[0]?.amendments.map(({ behavior, delivered }) => [behavior, delivered]))
      .toEqual([["steer", true], ["followUp", true]]);
  });

  test("a resized terminal is drawn again, the editor and footer still at the bottom", async () => {
    const { terminal, session } = shellOn(["An answer that has to wrap when the terminal grows narrower than it is."], "fullscreen", [100, 24]);
    terminal.type("go");
    terminal.type(enter);
    await settled(session);
    terminal.resize(40, 20);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const screen = await terminal.screen();
    expect(screen.at(-1)).toContain("scripted model");
    expect(shown(screen)).toContain("narrower");
    expect(screen.every((line) => line.length <= 40)).toBe(true);
  });

  test("in a long conversation the latest stays in view, and reading back holds still while the answer streams", async () => {
    const long = Array.from({ length: 80 }, (_, k) => `line ${k} of a long answer`).join("\n\n");
    const last = Array.from({ length: 30 }, (_, k) => `still streaming ${k}`).join(" ");
    const { terminal, session } = shellOn([long, last], "fullscreen", [80, 24], { tokensPerSecond: 150 });
    terminal.type("first");
    terminal.type(enter);
    await settled(session);
    expect(await terminal.until("line 79 of a long answer", 10_000)).toContain("scripted model");
    terminal.type("second");
    terminal.type(enter);
    await terminal.until("Working");
    terminal.type("\x1b[5~");
    terminal.type("\x1b[5~");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const reading = await terminal.screen();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await terminal.screen()).slice(0, 10)).toEqual(reading.slice(0, 10));
    await settled(session);
  }, 30_000);

  test("search finds a word in the conversation", async () => {
    const long = Array.from({ length: 60 }, (_, k) => k === 3 ? "the needle is here" : `filler line ${k}`).join("\n\n");
    const { terminal, session } = shellOn([long]);
    terminal.type("go");
    terminal.type(enter);
    await settled(session);
    expect(shown(await terminal.screen())).not.toContain("needle");
    terminal.type("\x1b[102;6u");
    terminal.type("needle");
    expect(await terminal.until("the needle is here")).toContain("the needle is here");
  });

  test("text selected with the mouse is copied when the button is released", async () => {
    const copied: string[] = [];
    const { terminal, session } = shellOn(["copy this answer please"], "fullscreen", [80, 24],
      { copy: (text) => { copied.push(text); return Promise.resolve(true); } });
    terminal.type("go");
    terminal.type(enter);
    await settled(session);
    const screen = await terminal.screen();
    const row = screen.findIndex((line) => line.includes("copy this answer please")) + 1;
    const column = (screen[row - 1] ?? "").indexOf("copy") + 1;
    terminal.type(`\x1b[<0;${column};${row}M`);
    terminal.type(`\x1b[<32;${column + 8};${row}M`);
    terminal.type(`\x1b[<0;${column + 8};${row}m`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(copied.join("")).toContain("copy this");
  });

  test("Ctrl+C clears the editor, and twice on an empty one ends the shell", async () => {
    const { terminal, shell } = shellOn([]);
    terminal.type("half a thought");
    await terminal.until("half a thought");
    terminal.type("\x1b[99;5u");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(shown(await terminal.screen())).not.toContain("half a thought");
    terminal.type("\x1b[99;5u");
    await terminal.until("Press Ctrl+C again");
    terminal.type("\x1b[99;5u");
    await shell.stopped;
  });
});
