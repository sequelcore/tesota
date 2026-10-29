import { createModels, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { setCapabilityOverrides, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GREETINGS, WORDMARK } from "../../../src/welcome-header.ts";
import { workingOrb } from "../../../src/working-orb.ts";
import { runApp } from "../src/shell/app.ts";
import { shellTheme } from "../../../src/theme.ts";
import type { ScriptStep } from "./engine.ts";
import { scriptedReply } from "./scripted.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Tesota's own interface in the engine's shell (#446), as the operator sees
 * it: the welcome screen, the input band, the evidence
 * footer, the working orb, the receipt card, and the
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
  await terminal.until("for commands");
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

  test("slash suggestions open above the input band, as Claude Code and Codex do, and Tab completes one", async () => {
    const { terminal, running } = await app([]);
    try {
      terminal.type("/");
      await terminal.until("Choose the model");
      const screen = await terminal.screen();
      const suggestion = screen.findIndex((line) => /model\s+Choose the model/u.test(line));
      expect(suggestion).toBeLessThan(screen.findIndex((line) => line.startsWith("› ")));
      expect(screen[suggestion]).toMatch(/^\s+› model/u);
      terminal.type("res");
      await terminal.until("Open an earlier session");
      terminal.type("\t");
      expect(await terminal.untilGone("Open an earlier session")).toContain("› /resume");
    } finally {
      await quit(terminal, running);
    }
  });

  test("the empty screen shows the wordmark, its version and a greeting, the input under them and the evidence footer below", async () => {
    const { terminal, running, branch } = await app([]);
    const screen = await terminal.screen();
    // No header row: the wordmark's four rows are the only block letters, centered, with the version and a greeting under them.
    expect(screen.filter((line) => /[▀▄█]/u.test(line))).toHaveLength(WORDMARK.length);
    expect(screen[0]?.trim()).toBe("");
    const mark = screen.findIndex((line) => line.includes(WORDMARK[1]!.trim()));
    expect(screen[mark + 3]).toMatch(/^\s+v\S+ · /u);
    expect(GREETINGS).toContain(screen[mark + 5]?.trim() ?? "");
    expect(screen.filter((line) => line.startsWith("› "))).toHaveLength(1);
    expect(screen.join("\n")).not.toContain("▌");
    // The footer is one row: the evidence, and the permission mode (#449), a status it never drops; this temporary folder's long
    // path is the first thing it drops, so the branch shows only in a wider terminal.
    expect(screen.at(-1)).toContain("● ready");
    expect(screen.at(-1)).toContain("full access");
    expect(screen.at(-1)).not.toContain(`(${branch})`);
    await quit(terminal, running);
  });

  test("while the agent works the orb turns beside its label, two rows of half blocks in the theme's colors", async () => {
    const { terminal, running } = await app(["an answer that streams slowly enough to watch the orb turn"], 8);
    terminal.type("go");
    terminal.type(enter);
    const screen = (await terminal.until("Working")).split("\n");
    const row = screen.findIndex((line) => line.includes("Working"));
    expect(screen[row]).toMatch(/^ ▀{4} Working…/u);
    expect(screen[row + 1]).toMatch(/^ ▀{4}/u);
    // Drawn from the orb the theme gives: its first working frame's pixels, top and bottom, are truecolor.
    const frame = workingOrb(shellTheme("dark", "truecolor")).phases.working.frames[0]!;
    expect(frame.map((line) => stripTerminalSequences(line))).toEqual(["▀▀▀▀", "▀▀▀▀"]);
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
    // The input band follows the same light theme, background and text, rather than the removed bar.
    expect(terminal.written.slice(0, before)).toContain("48;2;24;24;26");
    expect(terminal.written.slice(before)).toContain("48;2;240;240;242");
    expect(terminal.written.slice(before)).toContain("38;2;24;24;27");
    await quit(terminal, running);
  });
});
