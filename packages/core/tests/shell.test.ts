import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Editor, sliceByColumn, visibleWidth, type SlashCommand } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiMode } from "../src/settings.ts";
import { createSession, type SessionOptions, type EngineSession } from "../src/session.ts";
import { type Shell, startShell } from "../src/shell/shell.ts";
import { provideHost } from "../../../src/host.ts";
import { createSurface, shellHost, type Surface } from "../src/shell/surface.ts";
import type { ClarificationQuestion } from "../../../src/clarification.ts";
import { shellTheme } from "../../../src/theme.ts";
import { BarEditor } from "../../../src/editor.ts";
import { mountWelcomeHeader, WelcomeHeader } from "../../../src/welcome-header.ts";
import { readSessionFile } from "../src/session-file.ts";
import { ModelViewer } from "../src/shell/model-viewer.ts";
import { loadModelView } from "../../../src/model-view-process.ts";
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
  extra: { tokensPerSecond?: number; copy?: (text: string) => Promise<boolean>; commands?: readonly SlashCommand[]; surface?: Surface;
    questions?: SessionOptions["questions"]; cwd?: string; command?: (text: string) => Promise<boolean>; answersQueriesAfterMs?: number; agents?: () => void } = {}) {
  const faux = fauxProvider({ tokensPerSecond: extra.tokensPerSecond ?? 400 });
  faux.setResponses(script.map(scriptedReply));
  const models = createModels();
  models.setProvider(faux.provider);
  const { cwd = folder("tesota-core-shell-"), answersQueriesAfterMs, ...options } = extra;
  const session = createSession({ cwd, folder: folder("tesota-core-sessions-"), models, model: faux.getModel(), verifier: accepts, ...extra.questions === undefined ? {} : { questions: extra.questions } });
  const terminal = new VirtualTerminal(...size);
  terminal.answersQueriesAfterMs = answersQueriesAfterMs;
  const shell = startShell({ terminal, mode, fullRepaint: false, theme: shellTheme("dark", "truecolor"), session,
    status: () => "scripted model", ...options });
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
const choices = [{ question: "Which path should the agent take?", options: [
  { label: "conservative", description: "make the smallest change" },
  { label: "complete", description: "implement the full requested path" },
], recommended: 0 }] satisfies readonly ClarificationQuestion[];

describe("the shell", () => {
  test("a retry shows a live countdown and Esc cancels it (#698)", async () => {
    const { terminal, session } = shellOn([{ error: "503: temporarily unavailable" }, "must not be reached"]);
    terminal.type("Answer");
    terminal.type(enter);
    expect(await terminal.until("Esc to cancel")).toContain("Retry 1/3 in 1s");
    const ended = settled(session);
    terminal.type("\x1b");
    await ended;
    expect(session.outcome()).toBe("aborted");
    expect(shown(await terminal.screen())).not.toContain("must not be reached");
  });

  test("a returned provider error is bounded and redacted in the shell (#696)", async () => {
    const { terminal, session } = shellOn([{ error: `429: FreeUsageLimitError; api_key=synthetic-key ${"x".repeat(5000)}` }], "fullscreen", [100, 30]);
    terminal.type("Answer");
    terminal.type(enter);
    await settled(session);
    const screen = shown(await terminal.screen());
    expect(screen).toContain("FreeUsageLimitError");
    expect(screen).not.toContain("synthetic-key");
    expect(screen).toContain("The run ended error.");
  });

  test("a capped question stays visible after Ctrl+O rebuilds the transcript (#713)", async () => {
    const ask = { tool: "ask_user", args: { questions: choices } };
    const { terminal, session, shell } = shellOn([ask, ask, ask, ask], "fullscreen", [120, 40], {
      questions: (_questions, submit) => { submit([{ selected: [0] }]); return () => undefined; },
    });
    await session.prompt("Guide setup.");
    await terminal.until("Reply with your answer to continue the work");
    terminal.type("\x0f");
    const screen = await terminal.until("Operator");
    expect(screen).toContain("Reply with your answer to continue the work");
    expect(screen).toContain("The agent wanted to ask you something before going on:");
    expect(screen).toContain("Which path should the agent take?");
    const other = shellOn([]);
    shell.show(other.session);
    await terminal.untilGone("Reply with your answer to continue the work");
    shell.show(session);
    const restored = await terminal.until("Reply with your answer to continue the work");
    expect(restored).toContain("Which path should the agent take?");
    expect(restored).not.toContain('{"questions":');
    expect(restored).not.toContain("do not ask in plain text");
  });

  test("a capped ask_user never exposes raw JSON or model instructions, even expanded (#713)", async () => {
    const ask = { tool: "ask_user", args: { questions: choices } };
    const { terminal, session } = shellOn([ask, ask, ask, ask], "fullscreen", [120, 40], {
      questions: (_questions, submit) => { submit([{ selected: [0] }]); return () => undefined; },
    });
    await session.prompt("Guide setup.");
    const collapsed = await terminal.until("Reply with your answer to continue the work");
    expect(collapsed).not.toContain('{"questions":');
    expect(collapsed).not.toContain("Generation ends incomplete");
    terminal.type("\x0f");
    const expanded = await terminal.until("Operator selected:");
    expect(expanded).not.toContain('{"questions":');
    expect(expanded).not.toContain("do not ask in plain text");
    expect(expanded).toContain("Which path should the agent take?");
    expect(expanded).toContain("Reply with your answer to continue the work");
  });

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

  test("/ offers the session's skills beside the commands, and /name runs one as a request of its own (#540)", async () => {
    const cwd = folder("tesota-core-shell-skills-");
    const skill = (name: string, fields: string, body: string) => {
      mkdirSync(join(cwd, ".agents", "skills", name), { recursive: true });
      writeFileSync(join(cwd, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n${fields}---\n${body}\n`);
    };
    skill("verify-ledger", "description: Verify the ledger formally.\ndisable-model-invocation: true\n", "Hidden playbook text.");
    skill("background-only", "description: Only the model starts this.\nuser-invocable: false\n", "Background.");
    skill("resume", "description: A skill a command shadows.\n", "Shadowed.");
    let seen: string[] = [];
    const { terminal, session } = shellOn([{ seen: (context) => {
      seen = context.messages.flatMap((message) => message.role === "user" && typeof message.content === "string" ? [message.content] : []);
    }, reply: "Verified." }], "fullscreen", [100, 24], { cwd, commands: [{ name: "resume", description: "Open an earlier session" }],
      command: (text) => Promise.resolve(text.startsWith("/resume")) });
    terminal.type("/");
    const menu = await terminal.until("Verify the ledger formally.");
    expect(menu).toMatch(/resume\s+Open an earlier session/u);
    expect(menu).not.toContain("A skill a command shadows.");
    expect(menu).not.toContain("Only the model starts this.");
    terminal.type("\x03");
    terminal.type("/background-only now");
    terminal.type(enter);
    expect(await terminal.until("No command /background-only.")).not.toContain("Background.");
    terminal.type("/verify-ledger the session file");
    terminal.type(enter);
    await settled(session);
    const screen = shown(await terminal.screen());
    expect(screen).toContain("/verify-ledger the session file");
    expect(screen).toContain("Verified.");
    expect(screen).not.toContain("Hidden playbook text.");
    expect(seen[0]).toBe("/verify-ledger the session file");
    expect(seen[1]).toEndWith("Hidden playbook text.\n\nARGUMENTS: the session file");
    expect(session.ledger().map(({ text }) => text)).toEqual(["/verify-ledger the session file"]);
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

  test("an operator message has a dim prompt, aligned continuation and a full-width band", async () => {
    const { terminal, session } = shellOn(["answered"]);
    terminal.type("\x1b[200~first line\nsecond line\x1b[201~");
    terminal.type(enter);
    await settled(session);
    const screen = await terminal.screen();
    const row = screen.findIndex((line) => line.includes("first line"));
    expect(screen.slice(row, row + 2).map((line) => line.trimEnd())).toEqual([" › first line", "   second line"]);
    const buffer = await terminal.drawn();
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(1)?.getFgColor()).toBe(0x8f8d84);
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(3)?.getFgColor()).toBe(0xf2eee6);
    for (let line = row; line < row + 2; line++) {
      for (let column = 0; column < terminal.columns; column++) {
        expect(buffer.getLine(buffer.viewportY + line)?.getCell(column)?.getBgColor()).toBe(0x2f2a35);
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
    expect(screen[row]).toBe(" ✓ write a.txt");
    expect(screen[row + 1]).toBe("");
    expect(shown(screen)).not.toContain("Wrote");
    const buffer = await terminal.drawn();
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(1)?.getFgColor()).toBe(0xb9b7aa);
    expect(buffer.getLine(buffer.viewportY + row)?.getCell(3)?.isBold()).toBeGreaterThan(0);
    for (let column = 0; column < terminal.columns; column++) {
      expect(buffer.getLine(buffer.viewportY + row)?.getCell(column)?.isBgDefault()).toBe(true);
    }
    terminal.type("\x0f");
    const expanded = await terminal.until("Wrote 4 bytes to a.txt.");
    expect(expanded.split("\n").map((line) => line.trimEnd()).join("\n")).toContain(" ✓ write a.txt\n   Wrote 4 bytes to a.txt.");
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
    expect(expanded.split("\n").map((line) => line.trimEnd()).join("\n")).toContain(" ✓ edit a.txt +3 −2\n   - one\n   + first\n   + second\n   - two\n   + third");
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
    expect(screen).toContain(" ✗ read a.txt\n   Offset 99 is past the end of the file, which has 1 lines.");
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

  for (const mode of ["fullscreen", "inline"] as const) {
    for (const [ending, keys] of [["Ctrl+D", ["\x04"]], ["Ctrl+C twice", ["\x03", "\x03"]]] as const) {
      test(`ending the shell with ${ending} leaves no terminal reply at the prompt (${mode}, #574)`, async () => {
        const { terminal, session, shell } = shellOn(["Answered."], mode, [80, 24], { answersQueriesAfterMs: 20 });
        terminal.type("ask");
        terminal.type(enter);
        await settled(session);
        for (const key of keys) terminal.type(key);
        await shell.stopped;
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(terminal.atPrompt).toBe("");
        expect(shown(await terminal.scrollback())).toContain("Answered.");
      });
    }
  }

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
    await terminal.until("a first answer");
    terminal.type("also this");
    terminal.type(enter);
    expect(await terminal.until("Steer (next model turn): also this")).toContain("to edit all queued messages");
    terminal.type("then that");
    // Alt+Enter, as a terminal with the kitty keyboard protocol sends it.
    terminal.type("\x1b[13;3u");
    await terminal.until("Follow-up (when the run ends): then that");
    await settled(session);
    const screen = await terminal.until("answering both");
    expect(screen).not.toContain("Steer (next model turn)");
    expect(screen).not.toContain("Follow-up (when the run ends)");
    expect(screen.indexOf("also this")).toBeLessThan(screen.indexOf("answering both"));
    expect(screen.indexOf("then that")).toBeLessThan(screen.indexOf("answering both"));
    expect(session.ledger()[0]?.amendments.map(({ behavior, delivered }) => [behavior, delivered]))
      .toEqual([["steer", true], ["followUp", true]]);
  });

  for (const mode of ["fullscreen", "inline"] as const) {
    for (const action of ["edit", "abort"] as const) test(`${action} restores queued messages and the unsent draft without delivering them (${mode})`, async () => {
      const { terminal, session } = shellOn(["a first answer that streams slowly enough to withdraw pending messages", "a new answer"],
        mode, [100, 40], { tokensPerSecond: 20 });
      terminal.type("go");
      terminal.type(enter);
      await terminal.until("a first answer");
      terminal.type("withdraw steer");
      terminal.type(enter);
      await terminal.until("Steer (next model turn): withdraw steer");
      terminal.type("withdraw follow-up");
      terminal.type("\x1b[13;3u");
      await terminal.until("Follow-up (when the run ends): withdraw follow-up");
      terminal.type("unsent draft");
      const ended = settled(session);
      terminal.type(action === "abort" ? "\x1b" : process.platform === "win32" ? "\x1bq" : "\x1b[1;3A");
      const restored = await terminal.untilGone("to edit all queued messages");
      expect(restored).toContain("withdraw steer");
      expect(restored).toContain("withdraw follow-up");
      expect(restored).toContain("unsent draft");
      await ended;
      expect(session.history().filter((message) => message.role === "user").map((message) => message.content)).toEqual(["go"]);
      expect(session.ledger()[0]?.amendments.map(({ delivered, withdrawn }) => [delivered, withdrawn])).toEqual([[false, true], [false, true]]);
      expect(session.ledger()[0]?.inputs).toEqual([]);
      expect(readSessionFile(session.file).entries.filter((entry) => entry.type === "withdrawn").map(({ amendment }) => amendment)).toEqual([1, 2]);
      if (action === "edit") {
        // Clearing the editor withdraws the restored text; the next request must not requeue it.
        terminal.type("\x03");
        terminal.type("new request");
      } else terminal.type(" revised");
      terminal.type(enter);
      await settled(session);
      expect(session.ledger().map(({ text }) => text)).toEqual(["go", action === "edit" ? "new request"
        : "withdraw steer\n\nwithdraw follow-up\n\nunsent draft revised"]);
    });
  }

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

  test("a question does not select its recommendation, and submits only after its explicit submit action", async () => {
    const { terminal, shell, session } = shellOn([]);
    const submitted: unknown[] = [];
    const release = shell.askUser(session, choices, (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    const before = await terminal.until("recommended");
    expect(before).toContain("[ ] conservative (recommended)");
    terminal.type("2");
    terminal.type("\t");
    terminal.type("\t");
    terminal.type(enter);
    expect(submitted).toEqual([[{ selected: [1] }]]);
    release();
    await terminal.untilGone("Submit answers");
  });

  test.each(["fullscreen", "inline"] as const)("a question taller than the %s terminal scrolls, keeping its hint and the footer in view", async (mode) => {
    const { terminal, shell, session } = shellOn([], mode, [60, 14]);
    const long = "This choice changes every total the receipts show, with coupons, shipping and taxes.";
    const release = shell.askUser(session, [{ question: `Which orders get the discount? ${long}`, options: [
      { label: "over", description: `Only orders above 100. ${long}` }, { label: "from", description: `Orders of 100 too. ${long}` },
      { label: "before", description: `The total before coupons. ${long}` }, { label: "after", description: `The total after coupons. ${long}` },
    ] }], () => "Select an option or add text for every question.", () => undefined);
    const top = await terminal.until("Tab adds text");
    expect(top).toContain("scripted model");
    terminal.type("\t"); terminal.type("\t");
    const end = await terminal.until("Enter submits");
    expect(end).toContain("[Submit answers]");
    expect(end).toContain("scripted model");
    // The frame's bar runs down the scrolled choices and the pinned hint alike.
    for (const text of ["[Submit answers]", "Enter submits"]) {
      expect(end.split("\n").find((line) => line.includes(text))).toStartWith("▌");
    }
    terminal.type(enter);
    const refused = await terminal.until("Select an option or add text");
    expect(refused).toContain("scripted model");
    release();
  });

  test("a question leads its form at the transcript's column, with no spinner while it waits and a count only for several", async () => {
    const { terminal, shell, session } = shellOn([]);
    shell.busy("working");
    await terminal.until("Working…");
    const release = shell.askUser(session, choices, () => undefined, () => undefined);
    const screen = await terminal.until("Submit answers");
    expect(screen).not.toContain("Working…");
    expect(screen).not.toContain("Question 1/1");
    expect(screen).toContain("\n▌ Which path should the agent take?");
    expect(screen).toContain("\n▌ › 1. [ ] conservative (recommended)");
    release();
    await terminal.until("Working…");
    const several = shell.askUser(session, [...choices, { question: "And the tests?", options: [
      { label: "keep", description: "keep the tests as they are" }, { label: "extend", description: "add tests for the change" },
    ] }], () => undefined, () => undefined);
    expect(await terminal.until("Submit answers")).toMatch(/\n▌ Question 1\/2 +┃?\n▌ Which path should the agent take\?/u);
    several();
  });

  /** A gate's detail with a line the test sets, and how many listen. */
  function detailOf(first: string | undefined) {
    const listeners = new Set<() => void>();
    const state = { line: first };
    return { state, listeners, detail: { line: () => state.line, subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } }, set: (line: string | undefined) => { state.line = line; for (const listener of listeners) listener(); } };
  }

  test.each(["inline", "fullscreen"] as const)("verification controls stay visible in %s at normal and narrow widths", async (mode) => {
    for (const width of [100, 40]) {
      const { terminal, shell } = shellOn([], mode, [width, 24]);
      shell.busy("settling");
      const screen = await terminal.until("Esc: stop");
      expect(screen.replace(/\s+/gu, " ")).toContain("Verifying… · Alt+Enter: queue reply · Esc: stop");
      shell.busy(undefined);
    }
  });

  test("while the gate verifies, the label names the running command and its elapsed time, and plain words when none runs (#590)", async () => {
    const surface = createSurface(shellTheme("dark", "truecolor"));
    const gate = detailOf("Checking test sensitivity · bun test tests/rule.test.ts · 0:19");
    const { terminal, shell } = shellOn([], "fullscreen", [100, 24], { surface });
    surface.ui.setWorkingDetail(gate.detail);
    shell.busy("working");
    expect(await terminal.until("Working…")).not.toContain("bun test");
    expect(gate.listeners.size).toBe(0);
    shell.busy("settling");
    const screen = await terminal.until("Checking test sensitivity · bun test tests/rule.test.ts · 0:19");
    expect(screen).toContain("Verifying…");
    expect(screen).toContain("Alt+Enter: queue reply");
    expect(gate.listeners.size).toBe(1);
    gate.set("Running project check · bun run check · 6:02");
    await terminal.until("Running project check · bun run check · 6:02");
    gate.set(undefined);
    await terminal.until("Verifying…");
    shell.busy(undefined);
    expect(gate.listeners.size).toBe(0);
  });

  test("while the gate verifies, its block is the conversation's last, live and expanded by ctrl+o, and gone when it ends (#591)", async () => {
    const surface = createSurface(shellTheme("dark", "truecolor"));
    const gate = detailOf("Proving · src/a.ts · 0:01");
    const ledger = { block: "test-ledger", ...gate.detail };
    surface.registerMessageRenderer("test-ledger", (message, options) => message.details === ledger
      ? { render: () => [`LEDGER ${options.expanded ? "all" : "recent"} ${gate.state.line ?? "idle"}`], invalidate: () => undefined } : undefined);
    const { terminal, shell } = shellOn([], "fullscreen", [100, 24], { surface });
    surface.ui.setWorkingDetail(ledger);
    shell.busy("working");
    expect(await terminal.until("Working…")).not.toContain("LEDGER");
    shell.busy("settling");
    await terminal.until("LEDGER recent Proving · src/a.ts · 0:01");
    gate.set("Running project check · bun run check · 6:02");
    await terminal.until("LEDGER recent Running project check");
    terminal.type("\x0f");
    await terminal.until("LEDGER all Running project check");
    shell.busy(undefined);
    await terminal.untilGone("LEDGER");
    expect(gate.listeners.size).toBe(0);
  });

  test("nothing stays subscribed to the gate after a session switch or the shell stopping (#590)", async () => {
    const surface = createSurface(shellTheme("dark", "truecolor"));
    const gate = detailOf("Proving · src/a.ts · 0:01");
    const first = shellOn([], "fullscreen", [100, 24], { surface });
    const second = shellOn([]);
    surface.ui.setWorkingDetail(gate.detail);
    first.shell.busy("settling");
    await first.terminal.until("Proving · src/a.ts · 0:01");
    expect(gate.listeners.size).toBe(1);
    first.shell.show(second.session, createSurface(shellTheme("dark", "truecolor")), "settling");
    expect(gate.listeners.size).toBe(0);
    first.shell.show(first.session, surface, "settling");
    await first.terminal.until("Proving · src/a.ts · 0:01");
    expect(gate.listeners.size).toBe(1);
    first.shell.stop();
    expect(gate.listeners.size).toBe(0);
  });

  test("everything in the input's place has one frame: a bar whose color says what it asks, one title style, one marker", async () => {
    const theme = shellTheme("dark", "truecolor");
    const approve = theme.fg("warning", "▌");
    const answer = theme.fg("accent", "▌");
    const title = (text: string): string => theme.bold(theme.fg("accent", text));
    const framedRows = (screen: string, from: string, to: string): string[] => {
      const lines = screen.split("\n");
      const start = lines.findIndex((line) => line.includes(from));
      const end = lines.findIndex((line, index) => index >= start && line.includes(to));
      return lines.slice(start, end + 1);
    };
    const each = async (open: (shell: Shell, session: EngineSession) => Promise<unknown> | (() => void), from: string, to: string,
      bar: string, marker?: string): Promise<void> => {
      const { terminal, shell, session } = shellOn([]);
      const settled = open(shell, session);
      const screen = await terminal.until(to);
      const rows = framedRows(screen, from, to);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).toStartWith("▌");
      expect(terminal.written).toContain(bar);
      expect(terminal.written).toContain(title(from));
      if (marker !== undefined) {
        expect(screen).toContain(marker);
        const row = screen.split("\n").findIndex((line) => line.includes(marker));
        const drawn = await terminal.drawn();
        const selected = drawn.getLine(drawn.viewportY + row)!;
        // The frame owns columns 0–1; the selection fills every column of the list itself.
        const end = terminal.columns - (marker.includes("[ ]") ? 1 : 0);
        for (let column = 2; column < end; column++) {
          expect(selected.getCell(column)!.getBgColor()).toBe(0x4b3d53);
        }
        expect(selected.getCell(0)!.isBgDefault()).toBe(true);
      }
      if (typeof settled === "function") settled(); else { terminal.type("\x1b"); await settled; }
    };
    await each((shell) => shell.confirm({ title: "Write a.txt?", body: "hello", note: "Asked in ask mode.", items: [
      { value: "once", label: "Yes" }, { value: "deny", label: "No" }] }), "Write a.txt?", "2. No", approve, "› 1. Yes");
    await each((shell) => shell.pick("Choose a model", [{ value: "a", label: "first" }, { value: "b", label: "second" }]),
      "Choose a model", "second", answer, "› first");
    await each((shell) => shell.ask("Name the branch"), "Name the branch", "Name the branch", answer);
    await each((shell, session) => shell.askUser(session, choices, () => undefined, () => undefined),
      "Which path should the agent take?", "Esc cancels", answer, "› 1. [ ] conservative");
  });

  test("the mouse reaches what a frame holds: a click picks a choice, and moves a prompt's cursor", async () => {
    const click = (terminal: VirtualTerminal, column: number, row: number): void => {
      terminal.type(`\x1b[<0;${column};${row}M`);
      terminal.type(`\x1b[<0;${column};${row}m`);
    };
    const picking = shellOn([]);
    const picked = picking.shell.pick("Choose a model", [{ value: "a", label: "first" }, { value: "b", label: "second" },
      { value: "c", label: "third" }]);
    const screen = (await picking.terminal.until("third")).split("\n");
    const row = screen.findIndex((line) => line.includes("third"));
    click(picking.terminal, (screen[row] ?? "").indexOf("third") + 1, row + 1);
    expect(await picked).toBe("c");

    const asking = shellOn([]);
    const asked = asking.shell.ask("Name the branch");
    await asking.terminal.until("Name the branch");
    for (const char of "abc") asking.terminal.type(char);
    const lines = (await asking.terminal.until("abc")).split("\n");
    const at = lines.findIndex((line) => line.includes("abc"));
    expect(lines[at]).toStartWith("▌");
    click(asking.terminal, (lines[at] ?? "").indexOf("abc") + 2, at + 1);
    asking.terminal.type("X");
    asking.terminal.type(enter);
    expect(await asked).toBe("aXbc");
  });

  test("the hint says how to reach and use the submit action, and selection keys there do not change the answer", async () => {
    const { terminal, shell, session } = shellOn([]);
    const submitted: unknown[] = [];
    const release = shell.askUser(session, choices, (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    expect(await terminal.until("recommended")).toContain("Tab adds text");
    terminal.type("2");
    terminal.type("\t");
    expect(await terminal.until("Tab or Enter goes to Submit")).toContain("Esc cancels");
    terminal.type("\t");
    expect(await terminal.until("Enter submits")).toContain("Tab goes back to the choices");
    terminal.type(" ");
    terminal.type("1");
    terminal.type(enter);
    expect(submitted).toEqual([[{ selected: [1] }]]);
    release();
  });

  test("a multiple-choice answer keeps its selected options and supplemental text", async () => {
    const { terminal, shell, session } = shellOn([], "fullscreen", [36, 24]);
    const submitted: unknown[] = [];
    const release = shell.askUser(session, [{ question: "Pick every useful input for a narrow terminal.", multiple: true, options: [
      { label: "first", description: "first option" }, { label: "second", description: "second option" },
    ] }], (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    await terminal.until("Pick every useful");
    terminal.type("1");
    terminal.type("2");
    terminal.type("\t");
    terminal.type("operator context");
    terminal.type("\t");
    terminal.type(enter);
    expect(submitted).toEqual([[{ selected: [0, 1], text: "operator context" }]]);
    expect((await terminal.screen()).every((line) => line.length <= 36)).toBe(true);
    release();
  });

  test("model control characters cannot repaint the question's selection chrome", async () => {
    const { terminal, shell, session } = shellOn([]);
    const submitted: unknown[] = [];
    const label = `${"\b".repeat(12)}\x1b[31mForged\x1b[0m\x07\u009b`;
    const release = shell.askUser(session, [{ question: "Safe\x1b[2J question\b", options: [
      { label, description: "Description\x07\u009b" }, { label: "Ordinary", description: "Normal choice." },
    ] }], (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    const screen = await terminal.until("Forged");
    expect(screen).toContain(`› 1. [ ] ${"�".repeat(12)}Forged��`);
    expect(terminal.written).not.toContain(label);
    terminal.type("2"); terminal.type("\t"); terminal.type("\t"); terminal.type(enter);
    expect(submitted).toEqual([[{ selected: [1] }]]);
    release();
  });

  test("a question draft survives two session switches and a late release cannot submit it", async () => {
    const first = shellOn([]);
    const second = shellOn([]);
    const submitted: unknown[] = [];
    const release = first.shell.askUser(first.session, choices, (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    await first.terminal.until("Submit answers");
    first.terminal.type("2");
    first.shell.show(second.session);
    first.shell.show(first.session);
    expect(await first.terminal.until("[x] complete")).toContain("[ ] conservative");
    first.shell.show(second.session);
    release();
    first.shell.show(first.session);
    await first.terminal.untilGone("Submit answers");
    first.terminal.type("2\t\t\r");
    expect(submitted).toEqual([]);
  });

  test.each(["fullscreen", "inline"] as const)("long questions scroll through every option and keep the active field visible (%s)", async (mode) => {
    const { terminal, shell, session } = shellOn([], mode, [36, 24]);
    const batch = Array.from({ length: 3 }, (_, q) => ({ question: `Question body ${q}`, options: Array.from({ length: 4 }, (_, o) => ({
      label: `Choice ${q}-${o}`, description: `${"context ".repeat(140)}END ${q}-${o}`,
    })) }));
    const submitted: unknown[] = [];
    const release = shell.askUser(session, batch, (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    for (let q = 0; q < 3; q++) {
      await terminal.until(`Question ${q + 1}/3`);
      for (let o = 0; o < 4; o++) {
        await terminal.until(`› ${o + 1}. [ ] Choice ${q}-${o}`);
        let visible = false;
        for (let page = 0; page < 5 && !visible; page++) {
          terminal.type("\x1b[6~");
          await new Promise((resolve) => setTimeout(resolve, 25));
          visible = (await terminal.screen()).some((line) => line.includes(`END ${q}-${o}`));
        }
        expect(visible).toBe(true);
        if (o < 3) terminal.type("\x1b[B");
      }
      terminal.type("4");
      if (q < 2) terminal.type("\x1b[C");
    }
    terminal.type("\t"); await terminal.until("Text:");
    terminal.type("\t"); await terminal.until("› [Submit answers]");
    terminal.type(enter);
    expect(submitted).toEqual([[{ selected: [3] }, { selected: [3] }, { selected: [3] }]]);
    release();
  });
});

/** A real TLC capture of `fixtures/model-viewer/Lights.tla`: complete with `-continue`, or partial where TLC stopped at the first violation. */
const lights = (kind: "complete" | "partial"): string => join(import.meta.dir, "fixtures", "model-viewer", `lights-${kind}.manifest.json`);
const esc = "\x1b";

/** Opens the graph viewer over `shell` as `/graph` does, through the real disposable worker; `loads` collects each load's signal. */
function viewerOn(shell: Shell, terminal: VirtualTerminal, manifest = lights("complete"), loads: AbortSignal[] = []): void {
  let hide = (): void => undefined;
  const viewer = new ModelViewer({ theme: shellTheme("dark", "truecolor"), subject: "Lights.tla", rows: () => terminal.rows,
    load: (request, signal) => { loads.push(signal); return loadModelView(manifest, request, signal); },
    close: () => { hide(); }, redraw: () => { shell.redraw(); } });
  hide = shell.overlay(viewer);
}

/** Read whole box interiors across wrapped rows, excluding the neighboring panel. */
function graphBoxes(screen: string): string[] {
  const rows = screen.split("\n");
  return rows.flatMap((row, y) => [...row.matchAll(/┌─+┐/gu)].map(match => {
    const x = visibleWidth(row.slice(0, match.index)), w = visibleWidth(match[0]);
    const body: string[] = [];
    for (const next of rows.slice(y + 1)) {
      if (sliceByColumn(next, x, 1) === "└") break;
      body.push(sliceByColumn(next, x + 1, w - 2).trim());
    }
    return body.join(" ");
  }));
}

describe("the model graph viewer (#592)", () => {
  test("each key acts on a small real TLC graph, read through its worker", async () => {
    const { terminal, shell } = shellOn([], "fullscreen", [120, 40]);
    viewerOn(shell, terminal);
    let screen = await terminal.until("grouped by door > lamp");
    expect(screen).toContain("Model graph · Lights.tla");
    expect(screen).toContain("Complete exploration; exact counts · reached 8 · edges 16 · reported violating 2");
    expect(screen).toContain("Arrows between groups are possible moves, not one run");
    expect(graphBoxes(screen).some(box => box.includes("2 states · ⚠ breaks DarkWhenLocked · 2 states"))).toBe(true);
    // The first reported violation is selected, with its full variables.
    expect(screen).toContain("TLC id -7489905741496962076");
    expect(screen).toContain("⚠ breaks DarkWhenLocked");
    for (const variable of ['door = "locked"', 'lamp = "on"', "n = 0"]) expect(screen).toContain(variable);

    terminal.type("+"); await terminal.until("detail 2/3");
    expect(await terminal.until("Unlock→")).toContain("Lock→");
    terminal.type("+"); await terminal.until("detail 3/3");
    expect(await terminal.until("n ∈ {0, 1}")).toContain("4. ");
    terminal.type("+"); terminal.type("-"); await terminal.until("detail 2/3");
    terminal.type("-"); terminal.type("-"); await terminal.until("detail 1/3");

    terminal.type("n"); screen = await terminal.until("TLC id -752285075239298876");
    expect(screen).toContain("⚠ breaks DarkWhenLocked · 2/2");
    terminal.type("n"); await terminal.until("⚠ breaks DarkWhenLocked · 1/2");
    terminal.type("p"); await terminal.until("TLC id -752285075239298876");

    terminal.type("t"); screen = await terminal.until("TLC concrete trace · 3 steps");
    expect(screen).toContain("only execution shown");
    expect(screen).not.toContain("grouped by");
    expect(screen).toContain("<Lock");
    // The trace's last state is the violating one TLC reported.
    expect(screen).toContain("TLC id -7489905741496962076");
    terminal.type("t"); await terminal.until("grouped by door > lamp");

    terminal.type("\t"); await terminal.until("TLC id 3588016040887795817");

    terminal.type("g"); await terminal.until("Group by");
    terminal.type("zzz"); terminal.type(enter);
    await terminal.until("Choose up to two distinct existing variables");
    terminal.type(esc); await terminal.untilGone("Group by");
    terminal.type("g"); await terminal.until("Group by");
    terminal.type("n"); terminal.type(enter);
    screen = await terminal.until("grouped by n ·");
    expect(screen).toContain("n = 0");
    expect(graphBoxes(screen).some(box => box.includes("4 states · ⚠ breaks DarkWhenLocked · 1 state"))).toBe(true);

    terminal.type(enter); screen = await terminal.until("within n: 0");
    expect(screen).toContain("grouped by each state");
    expect(screen).toContain("reached 4 · edges inside 6 · crossing 4");
    terminal.type(esc); await terminal.until("grouped by n · all reached states");

    terminal.type("/"); await terminal.until("Search reached states");
    terminal.type('lamp = "on"'); terminal.type(enter);
    await terminal.until("Match 1/4");
    terminal.type(enter); await terminal.until("Match 2/4");
    terminal.type(esc); await terminal.untilGone("Search reached states");
    terminal.type(esc); await terminal.untilGone("Model graph");
  }, 30_000);

  test("keys, a drag and the wheel pan the graph, no further than it goes", async () => {
    const { terminal, shell } = shellOn([], "fullscreen", [100, 14]);
    viewerOn(shell, terminal);
    await terminal.until("grouped by door > lamp");
    // The initial state's group, at the drawing's top left.
    terminal.type("+"); terminal.type("+"); terminal.type("\t"); await terminal.until("pan 0,0");
    terminal.type("\x1b[C"); await terminal.until("pan 8,0");
    terminal.type("\x1b[B"); await terminal.until("pan 8,3");
    terminal.type("\x1b[D"); terminal.type("\x1b[A"); await terminal.until("pan 0,0");
    terminal.type("\x1b[<0;30;10M"); terminal.type("\x1b[<32;22;8M"); terminal.type("\x1b[<0;22;8m");
    await terminal.until("pan 8,2");
    // The wheel pans too, no further than the drawing goes.
    terminal.type("\x1b[<65;30;10M"); await terminal.until("pan 8,5");
    let last = 5;
    for (let step = 0; step < 30; step++) {
      terminal.type("\x1b[<65;30;10M");
      const screen = (await terminal.screen()).join("\n");
      const next = Number(/pan 8,(\d+)/u.exec(screen)?.[1]);
      expect(next).toBeGreaterThanOrEqual(last);
      expect(next - last).toBeLessThanOrEqual(3);
      if (next === last) {
        terminal.type("\x1b[<65;30;10M");
        expect((await terminal.screen()).join("\n")).toContain(`pan 8,${last}`);
        return;
      }
      last = next;
    }
    throw new Error("Wheel panning did not stop at the drawing's edge");
  });

  test("a manifest's names reach the screen without their control sequences, and a full-width value keeps every character", async () => {
    const { terminal, shell } = shellOn([], "fullscreen", [120, 40]);
    const wide = Array.from({ length: 60 }, (_, k) => String.fromCodePoint(0x4e00 + k)).join("");
    let hide = (): void => undefined;
    // The real view, as a forged manifest would make it: a title-setting sequence in an invariant's name, a long full-width value.
    hide = shell.overlay(new ModelViewer({ theme: shellTheme("dark", "truecolor"), subject: "Lights.tla", rows: () => terminal.rows,
      load: async (request, signal) => {
        const view = await loadModelView(lights("complete"), request, signal);
        return { ...view, states: view.states.map((state) => state.breaks.length === 0 ? state
          : { ...state, breaks: ["Dark\x1b]0;pwned\x07When"], valuation: `${state.valuation}\n/\\ s = "${wide}"` }) };
      },
      close: () => { hide(); }, redraw: () => { shell.redraw(); } }));
    let screen = await terminal.until("grouped by door > lamp");
    expect(screen).toContain("⚠ breaks Dark");
    expect(terminal.written).not.toContain("\x1b]0;pwned");
    for (const char of wide) expect(screen).toContain(char);
    terminal.type("t");
    screen = await terminal.until("TLC concrete trace · 3 steps");
    expect(screen).toContain("⚠ breaks Dark");
    expect(terminal.written).not.toContain("\x1b]0;pwned");
    terminal.type(esc); terminal.type(esc);
    await terminal.untilGone("Model graph");
  });

  test("partial counts read as lower bounds", async () => {
    const { terminal, shell } = shellOn([], "fullscreen", [120, 40]);
    viewerOn(shell, terminal, lights("partial"));
    const screen = await terminal.until("grouped by door > lamp");
    expect(screen).toContain("Partial exploration: counts are at least these numbers · reached ≥4 · edges ≥4 · reported violating ≥1");
    expect(graphBoxes(screen).some(box => box.includes("≥1 state · ⚠ breaks DarkWhenLocked · ≥1 state"))).toBe(true);
  });

  test("Esc closes the viewer's own prompt, then the viewer, before a dialog under it, and a dialog opened over it waits", async () => {
    const { terminal, shell } = shellOn([], "fullscreen", [120, 40]);
    const picked = shell.pick("Choose a model", [{ value: "a", label: "first" }]);
    await terminal.until("first");
    viewerOn(shell, terminal);
    await terminal.until("grouped by door > lamp");
    const asked = shell.ask("Name the branch");
    terminal.type("/"); await terminal.until("Search reached states");
    terminal.type("x"); terminal.type(esc);
    expect(await terminal.untilGone("Search reached states")).toContain("Model graph");
    terminal.type(esc); await terminal.untilGone("Model graph");
    terminal.type("abc"); terminal.type(enter);
    expect(await asked).toBe("abc");
    terminal.type(esc);
    expect(await picked).toBeUndefined();
  });

  test("the shell keeps its reserved keys: Esc never stops the run under the viewer, Ctrl+T waits, Ctrl+C is the shell's", async () => {
    let dashboards = 0;
    const { terminal, shell, session } = shellOn(["a slow answer ".repeat(40)], "fullscreen", [120, 40],
      { tokensPerSecond: 60, agents: () => { dashboards++; } });
    terminal.type("go"); terminal.type(enter);
    await terminal.until("Working");
    viewerOn(shell, terminal);
    await terminal.until("grouped by door > lamp");
    terminal.type("\x1b[116;5u");
    terminal.type(esc); await terminal.untilGone("Model graph");
    expect(dashboards).toBe(0);
    // With the viewer closed, the same key is the shell's again.
    terminal.type("\x1b[116;5u");
    expect(dashboards).toBe(1);
    await settled(session);
    expect(shown(await terminal.screen())).not.toContain("The run ended aborted");
    viewerOn(shell, terminal);
    await terminal.until("grouped by door > lamp");
    terminal.type("\x1b[99;5u"); terminal.type("\x1b[99;5u");
    await shell.stopped;
  }, 30_000);

  test("opens and closes again and again, a close stopping the worker still loading and giving the editor back", async () => {
    const { terminal, shell } = shellOn([], "fullscreen", [120, 40]);
    terminal.type("draft");
    const before = await terminal.until("draft");
    for (let round = 0; round < 3; round++) {
      const loads: AbortSignal[] = [];
      viewerOn(shell, terminal, lights("complete"), loads);
      terminal.type(esc);
      expect(loads.map((signal) => signal.aborted)).toEqual([true]);
      expect(await terminal.untilGone("Model graph")).toEqual(before);
      viewerOn(shell, terminal);
      await terminal.until("grouped by door > lamp");
      terminal.type(esc);
      expect(await terminal.untilGone("Model graph")).toEqual(before);
    }
    terminal.type(" kept");
    await terminal.until("draft kept");
  }, 30_000);

  test("Esc returns to the same transcript position, with the draft and the editor's focus", async () => {
    const long = Array.from({ length: 60 }, (_, k) => `answer line ${k}`).join("\n\n");
    const { terminal, shell, session } = shellOn([long], "fullscreen", [120, 40]);
    terminal.type("go"); terminal.type(enter);
    await settled(session);
    terminal.type("\x1b[5~"); terminal.type("\x1b[5~");
    terminal.type("keep me");
    const before = await terminal.until("keep me");
    expect(before).not.toContain("answer line 59");
    viewerOn(shell, terminal);
    await terminal.until("grouped by door > lamp");
    terminal.type("\x1b[5~"); terminal.type("\x1b[6~"); terminal.type("\x1b[6~"); terminal.type("\x1b[<65;30;20M"); terminal.type("\x1b[<65;30;20M");
    terminal.type(esc);
    expect(await terminal.untilGone("Model graph")).toEqual(before);
    terminal.type("!");
    await terminal.until("keep me!");
  }, 30_000);

  test("a pending clarification stays underneath, untouched by the viewer's keys, and gets the keyboard back", async () => {
    const { terminal, shell, session } = shellOn([], "fullscreen", [120, 40]);
    const submitted: unknown[] = [];
    const release = shell.askUser(session, choices, (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    await terminal.until("Submit answers");
    viewerOn(shell, terminal);
    await terminal.until("grouped by door > lamp");
    terminal.type("2");
    terminal.type(esc);
    expect(await terminal.untilGone("Model graph")).toContain("[ ] complete");
    for (const key of ["2", "\t", "\t", enter]) terminal.type(key);
    expect(submitted).toEqual([[{ selected: [1] }]]);
    release();
  });

  test("a session switch while it is open keeps it open; Esc lands on the shown session, its question and each draft", async () => {
    const first = shellOn([], "fullscreen", [120, 40]);
    const second = shellOn([]);
    first.terminal.type("alpha draft");
    await first.terminal.until("alpha draft");
    const submitted: unknown[] = [];
    const release = first.shell.askUser(second.session, choices, (answers) => { submitted.push(answers); return undefined; }, () => undefined);
    viewerOn(first.shell, first.terminal);
    await first.terminal.until("grouped by door > lamp");
    first.shell.show(second.session);
    first.terminal.type("+");
    expect(await first.terminal.until("detail 2/3")).not.toContain("Submit answers");
    first.terminal.type(esc);
    await first.terminal.until("Submit answers");
    for (const key of ["2", "\t", "\t", enter]) first.terminal.type(key);
    expect(submitted).toEqual([[{ selected: [1] }]]);
    release();
    first.shell.show(first.session);
    await first.terminal.until("alpha draft");
  }, 30_000);
});

test("shell shutdown cancels an open model viewer's running worker", async () => {
  const { shell, terminal } = shellOn([]);
  let signal: AbortSignal | undefined;
  let worker: ReturnType<typeof loadModelView> | undefined;
  const viewer = new ModelViewer({ theme: shellTheme("dark", "truecolor"), subject: "Lights", rows: () => terminal.rows,
    load: (request, active) => {
      signal = active;
      worker = loadModelView(lights("complete"), request, active);
      return worker;
    }, close: () => undefined, redraw: () => shell.redraw() });
  shell.overlay(viewer);
  shell.stop();
  expect(signal?.aborted).toBe(true);
  await expect(worker).rejects.toThrow();
});

test("late and replaced model overlays cannot escape shell shutdown", async () => {
  const { shell, terminal } = shellOn([]);
  const signals: AbortSignal[] = [];
  const workers: ReturnType<typeof loadModelView>[] = [];
  const make = () => new ModelViewer({ theme: shellTheme("dark", "truecolor"), subject: "Lights", rows: () => terminal.rows,
    load: (request, signal) => {
      signals.push(signal);
      const worker = loadModelView(lights("complete"), request, signal);
      workers.push(worker);
      return worker;
    }, close: () => undefined, redraw: () => shell.redraw() });
  shell.overlay(make());
  shell.overlay(make());
  expect(signals[0]?.aborted).toBe(true);
  shell.stop();
  shell.overlay(make());
  expect(signals.map(signal => signal.aborted)).toEqual([true, true, true]);
  await Promise.all(workers.map(worker => expect(worker).rejects.toThrow()));
});


for (const mode of ["fullscreen", "inline"] as const) test(`empty stage stays outside the conversation and vanishes on first activity (${mode})`, async () => {
  provideHost(shellHost());
  const theme = shellTheme("dark", "truecolor");
  const surface = createSurface(theme);
  let now = 0;
  const ticks: (() => void)[] = [];
  surface.ui.setHeader((tui, look) => mountWelcomeHeader(new WelcomeHeader("/work/shop", look, {
    terminalRows: () => tui.terminal.rows, stageShare: 1 / 2, requestRender: () => tui.requestRender(), now: () => now,
    model: () => "scripted model", setTimer: (callback) => { ticks.push(callback); return () => undefined; },
  }), tui));
  surface.ui.setEditorComponent((tui, look) => new BarEditor(tui, look, () => theme));
  const { terminal, session, shell } = shellOn(["A reply."], mode, [100, 40], { surface });
  const opening = await terminal.until("A coding agent");
  expect(opening.split("\n").slice(0, 3).map((row) => row.slice(13))).toEqual([
    expect.stringMatching(/^Tesota v/u), "scripted model · /work/shop", "A coding agent that ends every run with a receipt.",
  ]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(shown(await terminal.screen())).toMatch(/▀{49}/u);
  for (let step = 0; step < 9; step++) {
    now += 100;
    ticks.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await terminal.screen();
  }
  const faded = await terminal.screen();
  const artRow = faded.findIndex((line) => /▀{49}/u.test(line));
  const artColumn = faded[artRow]!.search(/▀{49}/u);
  const cell = (await terminal.drawn()).getLine(artRow)?.getCell(artColumn);
  const color = cell?.getFgColor() ?? 0;
  expect(Math.max(color >> 16 & 255, color >> 8 & 255, color & 255)).toBeLessThan(110);
  terminal.type("typing a draft");
  expect(await terminal.until("typing a draft")).toMatch(/▀{49}/u);
  if (mode === "fullscreen") {
    terminal.type(`\x1b[<0;${artColumn + 1};${artRow + 1}M`);
    terminal.type(`\x1b[<0;${artColumn + 1};${artRow + 1}m`);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const replay = (await terminal.drawn()).getLine(artRow)?.getCell(artColumn)?.getFgColor() ?? 0;
    expect(replay).toBe(color);
    now += 150; ticks.shift()?.();
    expect(shown(await terminal.screen())).not.toBe(shown(faded));
  }
  terminal.type(enter);
  await settled(session);
  expect(shown(await terminal.screen())).not.toMatch(/▀{49}/u);
  expect(shown(await terminal.screen())).toContain("A reply.");
  shell.stop();
  expect(shown(await terminal.scrollback())).not.toMatch(/▀{49}/u);
});

for (const mode of ["fullscreen", "inline"] as const) test(`quitting an untouched session leaves no tree in scrollback (${mode})`, async () => {
  provideHost(shellHost());
  const surface = createSurface(shellTheme("dark", "truecolor"));
  surface.ui.setHeader((tui, look) => mountWelcomeHeader(new WelcomeHeader("/work/shop", look, {
    terminalRows: () => tui.terminal.rows, stageShare: 1 / 2, requestRender: () => tui.requestRender(),
  }), tui));
  const { terminal, shell } = shellOn([], mode, [100, 40], { surface });
  await terminal.until("A coding agent");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(shown(await terminal.screen())).toMatch(/▀{49}/u);
  shell.stop();
  expect(shown(await terminal.scrollback())).not.toMatch(/▀{49}/u);
});

test("a late light-background reply repaints existing user bands", async () => {
  const look = shellTheme("dark", "truecolor");
  const surface = createSurface(look);
  const { terminal, session } = shellOn(["Reply."], "fullscreen", [100, 40], { surface });
  terminal.type("hello");
  terminal.type(enter);
  await settled(session);
  const row = (await terminal.screen()).findIndex((line) => line.includes("› hello"));
  expect((await terminal.drawn()).getLine(row)?.getCell(3)?.getBgColor()).toBe(0x2f2a35);
  terminal.type("\x1b]11;rgb:eded/eded/e5e5\x1b\\");
  terminal.type("\x1b[?62;c");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const cell = (await terminal.drawn()).getLine(row)?.getCell(3);
  expect(cell?.getBgColor()).toBe(0xe4d9e9);
  expect(cell?.getFgColor()).toBe(0x24211f);
});

test("inline handoff clears the live tree before another program writes", async () => {
  provideHost(shellHost());
  const surface = createSurface(shellTheme("dark", "truecolor"));
  surface.ui.setHeader((tui, look) => mountWelcomeHeader(new WelcomeHeader("/work/shop", look, {
    terminalRows: () => tui.terminal.rows, stageShare: 1 / 2, requestRender: () => tui.requestRender(),
  }), tui));
  const { terminal, shell } = shellOn([], "inline", [100, 40], { surface });
  await terminal.until("▀".repeat(49));
  await shell.handOver(async () => {
    terminal.write("other program\r\n".repeat(50));
    expect(shown(await terminal.scrollback())).not.toMatch(/▀{49}/u);
  });
  await terminal.until("A coding agent");
  shell.stop();
  expect(shown(await terminal.scrollback())).not.toMatch(/▀{49}/u);
});

test("a resumed conversation never draws the empty stage", async () => {
  provideHost(shellHost());
  const { session, shell } = shellOn(["Existing reply."]);
  await session.prompt("Existing request.");
  const surface = createSurface(shellTheme("dark", "truecolor"));
  surface.ui.setHeader((tui, look) => mountWelcomeHeader(new WelcomeHeader("/work/shop", look, {
    terminalRows: () => 40, stageShare: 1 / 2, requestRender: () => tui.requestRender(),
  }), tui));
  const terminal = new VirtualTerminal(100, 40);
  const resumed = startShell({ terminal, session, surface, mode: "fullscreen", fullRepaint: false,
    theme: surface.theme, status: () => "resumed" });
  open.push({ session, shell: resumed });
  expect(await terminal.until("Existing reply.")).not.toMatch(/▀{49}/u);
  shell.stop();
});

test("a real header click rustles the live mark, including after first activity", async () => {
  provideHost(shellHost());
  const surface = createSurface(shellTheme("dark", "truecolor"));
  let now = 0;
  let redraw: () => void = () => undefined;
  const ticks: (() => void)[] = [];
  surface.ui.setHeader((tui, look) => { redraw = () => tui.renderNow(); return mountWelcomeHeader(new WelcomeHeader("/work/shop", look, {
    terminalRows: () => 40, stageShare: 0.5, requestRender: () => tui.renderNow(), now: () => now,
    setTimer: (callback) => { ticks.push(callback); return () => undefined; },
  }), tui); });
  const { terminal, session } = shellOn(["A reply."], "fullscreen", [100, 40], { surface });
  await terminal.until("Tesota v");
  now = 800; ticks.shift()?.();
  const resting = (await terminal.screen()).slice(0, 4);
  for (const active of [false, true]) {
    if (active) { terminal.type("go"); terminal.type(enter); await settled(session); }
    terminal.type("\x1b[<0;6;2M"); terminal.type("\x1b[<0;6;2m");
    redraw(); await terminal.screen();
    now += 200; ticks.shift()?.();
    expect((await terminal.screen()).slice(0, 4)).not.toEqual(resting);
    now += 800; ticks.shift()?.();
    expect((await terminal.screen()).slice(0, 4)).toEqual(resting);
  }
});
