import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { setCapabilityOverrides, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tumbleweedFrames } from "../../../src/welcome-header.ts";
import { runApp } from "../src/shell/app.ts";
import { shellTheme } from "../../../src/theme.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply } from "./scripted.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Tesota's own interface in the engine's shell (#446), as the operator sees
 * it: the welcome header with its tree, the barred editor, the evidence
 * footer, the tumbleweed while the agent works, the receipt card, and the
 * theme for the terminal's background. Pi is not loaded for any of it.
 */
const folder = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const enter = "\r";

/** A repository with a committed file, and the app on a scripted model in it, once it has drawn and a model is chosen. */
async function app(script: readonly ScriptStep[], tokensPerSecond = 400) {
  const cwd = folder("tesota-core-interface-");
  writeFileSync(join(cwd, "notes.md"), "# Notes\n");
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"]]) {
    expect(spawnSync("git", args, { cwd }).status).toBe(0);
  }
  const credentials = new InMemoryCredentialStore();
  const models = createModels({ credentials });
  const faux = fauxProvider({ tokensPerSecond });
  faux.setResponses(script.map(scriptedReply));
  models.setProvider(faux.provider);
  const terminal = new VirtualTerminal(100, 44);
  // In full access the run's writes need no answer; asking has its own tests (permissions, app).
  const settingsPath = join(folder("tesota-core-interface-settings-"), "s.json");
  writeFileSync(settingsPath, JSON.stringify({ permissionMode: "full" }));
  const running = runApp({ cwd, terminal, models, credentials, settingsPath,
    sessions: folder("tesota-core-interface-sessions-") });
  await terminal.until("Tesota (v");
  terminal.type("/model");
  terminal.type(enter);
  await terminal.until("Model");
  terminal.type(enter);
  await terminal.until("Model: ");
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).stdout.trim();
  return { terminal, running, branch };
}

const quit = async (terminal: VirtualTerminal, running: Promise<void>): Promise<void> => {
  // Ctrl+C first, so nothing left in the editor runs into the command.
  terminal.type("\x1b[99;5u");
  terminal.type("/quit");
  terminal.type(enter);
  await running;
};

describe("Tesota's interface on the engine", () => {
  // The checks read truecolor sequences, so they do not depend on whether the runner's environment says COLORTERM.
  beforeAll(() => { setCapabilityOverrides({ trueColor: true }); });
  afterAll(() => { setCapabilityOverrides({}); });

  test("slash suggestions open above the barred editor, as Claude Code and Codex do, and Tab completes one", async () => {
    const { terminal, running } = await app([]);
    try {
      terminal.type("/");
      await terminal.until("Choose the model");
      const screen = await terminal.screen();
      const suggestion = screen.findIndex((line) => /model\s+Choose the model/u.test(line));
      expect(suggestion).toBeLessThan(screen.findIndex((line) => line.startsWith("▌")));
      expect(screen[suggestion]).toMatch(/^\s+→ model/u);
      terminal.type("res");
      await terminal.until("Open an earlier session");
      terminal.type("\t");
      expect(await terminal.untilGone("Open an earlier session")).toContain("▌  /resume");
    } finally {
      await quit(terminal, running);
    }
  });

  test("the welcome header draws the palo fierro, and the barred editor and evidence footer sit below", async () => {
    const { terminal, running, branch } = await app([]);
    const screen = await terminal.screen();
    expect(screen.join("\n")).toContain("Shows evidence that the change does what you asked.");
    expect(screen.filter((line) => /[⠁-⣿]/u.test(line)).length).toBeGreaterThan(4);
    expect(screen.filter((line) => line.startsWith("▌")).length).toBeGreaterThanOrEqual(3);
    // The footer is one row: the evidence, and the permission mode (#449), a status it never drops; this temporary folder's long
    // path is the first thing it drops, so the branch shows only in a wider terminal.
    expect(screen.at(-1)).toContain("● ready");
    expect(screen.at(-1)).toContain("full access");
    expect(screen.at(-1)).not.toContain(`(${branch})`);
    await quit(terminal, running);
  });

  test("while the agent works the tumbleweed rolls where the working indicator is", async () => {
    const { terminal, running } = await app(["an answer that streams slowly enough to watch the tumbleweed roll by"], 8);
    terminal.type("go");
    terminal.type(enter);
    const frames = tumbleweedFrames(shellTheme("dark", "truecolor") as never).map((frame) => stripTerminalSequences(frame).trim());
    const working = (await terminal.until("Working")).split("\n").find((line) => line.includes("Working")) ?? "";
    expect(frames.some((frame) => frame !== "" && working.includes(frame))).toBe(true);
    await terminal.untilGone("Working", 20_000);
    await quit(terminal, running);
  }, 30_000);

  test("a run that changed a file settles with Tesota's receipt card, which Ctrl+O opens up", async () => {
    const { terminal, running } = await app([{ tool: "write", args: { path: "notes.md", content: "# Notes\nmore\n" } }, "added"]);
    terminal.type("add a line");
    terminal.type(enter);
    const card = await terminal.until("Tesota receipt");
    expect(card).toContain("notes.md");
    expect(await terminal.until("○ receipt")).toContain("not verified");
    terminal.type("\x0f");
    await terminal.untilGone("ctrl+o for details");
    await quit(terminal, running);
  });

  test("on a light terminal it draws in Tesota's light theme", async () => {
    const { terminal, running } = await app([]);
    const before = terminal.written.length;
    // The terminal's late answers to each question about its colors, the header's and the shell's: a white background, then the
    // device attributes that end each answer.
    const asked = (terminal.written.match(/\]11;\?/gu) ?? []).length;
    for (let answer = 0; answer < asked; answer++) {
      terminal.type("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
      terminal.type("\x1b[?62;c");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.type("x");
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The editor's bar, drawn again as the operator types, in tesota-light's border color #9c86a5 instead of the dark #8f7a99.
    expect(terminal.written.slice(0, before)).toContain("38;2;143;122;153");
    expect(terminal.written.slice(before)).toContain("38;2;156;134;165");
    await quit(terminal, running);
  });
});
