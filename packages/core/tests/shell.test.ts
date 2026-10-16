import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiMode } from "../src/settings.ts";
import { createSession, type EngineSession } from "../src/session.ts";
import { type Shell, startShell } from "../src/shell/shell.ts";
import { shellTheme } from "../src/shell/theme.ts";
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
  extra: { tokensPerSecond?: number; copy?: (text: string) => Promise<boolean> } = {}) {
  const faux = fauxProvider({ tokensPerSecond: extra.tokensPerSecond ?? 400 });
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd: folder("tesota-core-shell-"), folder: folder("tesota-core-sessions-"), models,
    model: faux.getModel(), verifier: accepts });
  const terminal = new VirtualTerminal(...size);
  const shell = startShell({ terminal, mode, fullRepaint: false, theme: shellTheme("dark", "truecolor"), session,
    status: () => "scripted model", ...extra.copy === undefined ? {} : { copy: extra.copy } });
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

  test("a tool call shows its tool and target, and an edit its removed and added lines", async () => {
    const { terminal, session } = shellOn([
      { tool: "write", args: { path: "a.txt", content: "one\n" } },
      { tool: "edit", args: { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] } },
      "done"]);
    terminal.type("change it");
    terminal.type(enter);
    await settled(session);
    const screen = shown(await terminal.screen());
    expect(screen).toContain("write a.txt");
    expect(screen).toContain("edit a.txt");
    expect(screen).toContain("- one");
    expect(screen).toContain("+ two");
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
});
