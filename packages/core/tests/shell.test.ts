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

function shellOn(script: readonly ScriptStep[], mode: TuiMode = "fullscreen", size: [number, number] = [80, 24]) {
  const faux = fauxProvider({ tokensPerSecond: 400 });
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const session = createSession({ cwd: folder("tesota-core-shell-"), folder: folder("tesota-core-sessions-"), models,
    model: faux.getModel(), verifier: accepts });
  const terminal = new VirtualTerminal(...size);
  const shell = startShell({ terminal, mode, fullRepaint: false, theme: shellTheme("dark", "truecolor"), session,
    status: () => "scripted model" });
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
});
