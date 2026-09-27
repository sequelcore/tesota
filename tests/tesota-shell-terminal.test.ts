import { stripTerminalSequences, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createTesotaShellTerminal } from "../src/tesota-shell-terminal.js";
import type { TranscriptEntry } from "../src/tesota-shell-transcript.js";

class TestTerminal implements Terminal {
  readonly writes: string[] = [];
  columns = 80;
  rows = 24;
  readonly kittyProtocolActive = false;
  private input: ((data: string) => void) | undefined;
  private resize: (() => void) | undefined;
  started = false;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resize = onResize;
    this.started = true;
  }
  stop(): void { this.started = false; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); }
  moveBy(_lines: number): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  send(data: string): void { this.input?.(data); }
  resizeTo(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.resize?.();
  }
}

/** The last drawn screen line whose visible text contains `text`, with its styling; the TUI clears each line before drawing it. */
function screenLine(raw: string, text: string): string {
  return raw.split("\x1b[2K").findLast((line) => stripTerminalSequences(line).includes(text)) ?? "";
}

function visible(terminal: TestTerminal): string {
  return stripTerminalSequences(terminal.writes.join("\n"));
}

it("retains the last message when stopping before the scheduled render", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  for (let index = 0; index < 30; index++) shell.write(`Earlier message ${index}\n`);
  tui.renderNow(true);
  terminal.writes.length = 0;
  shell.write("The response was invalid. No work was applied.\n");
  shell.stop();
  expect(visible(terminal)).toContain("The response was invalid. No work was applied.");
});

it("collapses long repository notices and expands them without sending a prompt", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 110;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const entries: TranscriptEntry[] = [];
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    onEntry: (_id, entry) => entries.push(entry) });
  shell.start();
  shell.write("Brought 4 newer changes from your repository into the workspace:\n  modified a.ts\n  modified b.ts\n  deleted c.txt\n  modified d.ts");
  const answer = shell.ask("> ");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("4 lines hidden · Alt+D /details");
  expect(visible(terminal)).not.toContain("modified b.ts");

  terminal.writes.length = 0;
  terminal.send("/details");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("modified b.ts");
  expect(entries).toHaveLength(1);
  terminal.send("continue");
  terminal.send("\r");
  await expect(answer).resolves.toBe("continue");
  expect(entries.at(-1)).toEqual({ kind: "user", text: "continue" });
  shell.stop();
});

it("opens shell commands on slash and keeps the prompt active after running one", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onNewSession = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onNewSession });
  shell.start();
  const answer = shell.ask("> ");
  terminal.send("/");
  tui.renderNow(true);
  const menu = visible(terminal);
  expect(menu).toContain("Start a session");
  expect(menu.indexOf("Start a session")).toBeLessThan(menu.indexOf("›/"));
  terminal.send("new");
  terminal.send("\r");
  expect(onNewSession).toHaveBeenCalledOnce();
  terminal.send("actual request");
  terminal.send("\r");
  await expect(answer).resolves.toBe("actual request");
  shell.stop();
});

it("passes /model and /sandbox with their argument, and /handoff, to the shell", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onModel = vi.fn();
  const onHandoff = vi.fn();
  const onSandbox = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onModel, onHandoff, onSandbox });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  terminal.send("/model claude-code:opus");
  terminal.send("\r");
  terminal.send("/model");
  terminal.send("\r");
  terminal.send("/handoff");
  terminal.send("\r");
  terminal.send("/sandbox docker");
  terminal.send("\r");
  terminal.send("/sandbox");
  terminal.send("\r");
  expect(onModel.mock.calls).toEqual([["default", "claude-code:opus"], ["default", undefined]]);
  expect(onHandoff).toHaveBeenCalledWith("default");
  expect(onSandbox.mock.calls).toEqual([["default", "docker"], ["default", undefined]]);
  shell.stop();
});

it("opens a model picker on /model: filtered by typing, a reasoning level with left and right, Enter switches", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onModel = vi.fn();
  const levels = ["low", "medium", "high", "xhigh", "max"] as const;
  const modelPicker = () => ({ current: "claude-code:opus", contextTokens: 48_300, entries: [
    { id: "codex:gpt-6-sol", detail: "your ChatGPT plan's limits", reasoning: levels },
    { id: "claude-code:opus", detail: "your Claude Code sign-in", reasoning: levels },
    { id: "claude-code:haiku", detail: "your Claude Code sign-in", reasoning: [] } ] });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onModel, modelPicker });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  const screen = (): string => { terminal.writes.length = 0; tui.renderNow(true); return visible(terminal); };
  terminal.send("/model");
  terminal.send("\r");
  expect(onModel).not.toHaveBeenCalled();
  const opened = screen();
  expect(opened).toContain("codex:gpt-6-sol");
  expect(opened).toMatch(/● claude-code:opus/u);
  expect(opened).toContain("←→ reasoning");
  expect(opened).toContain("A switch re-reads about 48k tokens without cache; /handoff starts fresh.");
  terminal.send("sol");
  const filtered = screen();
  expect(filtered).toContain("codex:gpt-6-sol");
  expect(filtered).not.toContain("claude-code:haiku");
  for (let step = 0; step < 3; step++) terminal.send("\x1b[C");
  expect(screen()).toContain("‹ high ›");
  terminal.send("\r");
  expect(onModel).toHaveBeenCalledWith("default", "codex:gpt-6-sol@high");
  // Esc closes the picker and leaves what was typed; a name typed in full still switches without it.
  shell.ask("> ").catch(() => undefined);
  terminal.send("/model hai");
  terminal.send("\x1b");
  expect(screen()).not.toContain("claude-code:haiku");
  shell.stop();
});

it("filters slash commands before dispatching a typed command", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onNewSession = vi.fn();
  const onCloseSession = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onNewSession, onCloseSession });
  shell.start();
  const answer = shell.ask("> ");
  terminal.send("/");
  terminal.send("close");
  terminal.send("\r");
  expect(onCloseSession).toHaveBeenCalledWith("default");
  expect(onNewSession).not.toHaveBeenCalled();
  terminal.send("request");
  terminal.send("\r");
  await expect(answer).resolves.toBe("request");
  shell.stop();
});

it.each([
  { theme: "tesota-dark" as const, highlight: "\x1b[48;2;75;61;83m" },
  { theme: "tesota-light" as const, highlight: "\x1b[48;2;226;214;232m" },
  { theme: "terminal" as const, highlight: "\x1b[7m" },
])("highlights the entire selected command row in $theme", ({ theme, highlight }) => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, theme });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  terminal.send("/");
  tui.renderNow(true);
  expect(terminal.writes.join("")).toContain(highlight);
  expect(visible(terminal)).toContain("› /new");
  terminal.writes.length = 0;
  terminal.send("\x1b[B");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("› /next");
  shell.stop();
});

it("restores long notices collapsed with their full text available", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    initialSession: { id: "saved", title: "Saved", entries: [
      { kind: "notice", tone: "info", text: "Brought changes:\na.ts\nb.ts\nc.ts\nd.ts" },
    ] } });
  shell.start();
  const answer = shell.ask("> ");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("4 lines hidden · Alt+D /details");
  terminal.writes.length = 0;
  terminal.send("/details");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("d.ts");
  terminal.send("okay");
  terminal.send("\r");
  await expect(answer).resolves.toBe("okay");
  shell.stop();
});

it("opens a long notice while the agent is working", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.report({ phase: "working" });
  shell.write("Brought changes:\na.ts\nb.ts\nc.ts\nd.ts");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("4 lines hidden");
  terminal.writes.length = 0;
  terminal.send("\x1bd"); // Alt+D works without an active prompt.
  tui.renderNow(true);
  expect(visible(terminal)).toContain("d.ts");
  shell.stop();
});

it("keeps absolute check commands as answers instead of shell commands", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const check = shell.ask("Checks to run: ");
  terminal.send("/usr/bin/true");
  terminal.send("\r");
  await expect(check).resolves.toBe("/usr/bin/true");
  const request = shell.ask("> ");
  terminal.send("/usr/bin/true should exist");
  terminal.send("\r");
  await expect(request).resolves.toBe("/usr/bin/true should exist");
  shell.stop();
});

it("renders Tesota Shell as one persistent terminal surface", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const now = vi.fn(() => 1_000);
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, now });

  shell.start();
  shell.write("The repository is bounded.\n");
  shell.report({ phase: "working" });
  now.mockReturnValue(3_000);
  shell.refreshElapsed();
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Working · 2s");
  const answer = shell.ask("> ");
  terminal.send("Explain the shell");
  terminal.send("\r");

  await expect(answer).resolves.toBe("Explain the shell");
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("tesota / Session 1");
  expect(screen).toContain("The repository is bounded.");
  expect(screen).toContain("Explain the shell");
  expect(screen).toContain("Ready");
  expect(screen).toContain("›");
  expect(screen).not.toContain("────");
  shell.stop();
  expect(terminal.started).toBe(false);
});

it("clears progress and input when a workspace session ends", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  shell.endSession("default");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Session ended");
  expect(visible(terminal)).not.toContain("Working");
  await expect(shell.askIn("default", "> ")).rejects.toThrow("ended");
  shell.stop();
});

it("keeps environment preparation visible at the first prompt until it finishes", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  terminal.resizeTo(140, 30);
  shell.reportFor("default", { phase: "preparing", activity: "Creating the sandbox" });
  shell.askIn("default", "> ").catch(() => undefined);
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Creating the sandbox");
  expect(visible(terminal)).toContain("1 Session 1");
  expect(visible(terminal)).toContain("Preparing");
  shell.reportFor("default", { phase: "working" });
  shell.clearProgressFor("default", "preparing");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Working");
  shell.clearProgressFor("default", "working");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Ready");
  shell.stop();
});

it.each([
  { theme: "tesota-dark" as const, accent: "198;168;210" },
  { theme: "tesota-light" as const, accent: "109;75;120" },
  { theme: "terminal" as const, accent: null },
])("renders $theme without changing the visible work state", ({ theme, accent }) => {
  const terminal = new TestTerminal();
  terminal.columns = 140;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, theme });
  shell.start();
  shell.report({ phase: "awaiting_decision" });
  shell.write("Scope approval is required before execution.");
  tui.renderNow(true);

  const rendered = terminal.writes.join("");
  const screen = visible(terminal);
  expect(screen).toContain("tesota");
  expect(screen).toContain("Waiting for your decision");
  expect(screen).toContain("Scope approval is required before execution.");
  if (accent === null) expect(rendered).not.toContain("\x1b[38;2;");
  else expect(rendered).toContain(`\x1b[38;2;${accent}mtesota`);
  shell.stop();
});

it("routes Ctrl+C to the active prompt or active operation and restores the terminal", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const interrupt = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, interrupt });
  shell.start();

  const answer = shell.ask("Answer: ");
  terminal.send("\x03");
  await expect(answer).rejects.toMatchObject({ name: "AbortError" });
  expect(interrupt).not.toHaveBeenCalled();

  terminal.send("\x03");
  expect(interrupt).toHaveBeenCalledOnce();
  shell.stop();
  expect(terminal.started).toBe(false);
});

// As in Claude Code, Pi and Gemini CLI: Ctrl+C stops work or clears the input, and quits only when pressed again.
it("clears the idle prompt with Ctrl+C and quits on a second press, never ending the session", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  let now = 0;
  const onQuit = vi.fn();
  const interrupt = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onQuit, interrupt, now: () => now });
  shell.start();
  let settled = false;
  shell.askIn("default", "> ").then(() => { settled = true; }, () => { settled = true; });
  terminal.send("draft");
  terminal.send("\x03");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Press Ctrl+C again to quit");
  terminal.writes.length = 0;
  terminal.send("x");
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("draft");
  terminal.send("\x7f");
  now += 10_000; // Past the window, a press only arms the quit again.
  terminal.send("\x03");
  expect(onQuit).not.toHaveBeenCalled();
  terminal.send("\x03");
  expect(onQuit).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(settled).toBe(false); // The request prompt is still waiting: the session did not end.
  expect(interrupt).not.toHaveBeenCalled();
  shell.stop();
});

it("quits with Ctrl+D pressed twice on an empty prompt, stops work with Esc, and no longer quits with Ctrl+Q", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onQuit = vi.fn();
  const interrupt = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onQuit, interrupt, now: () => 0 });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("\x1b"); // Esc while the agent works stops it, as Ctrl+C does.
  expect(interrupt).toHaveBeenCalledOnce();
  terminal.send("\x11"); // Ctrl+Q
  shell.askIn("default", "> ").catch(() => undefined);
  terminal.send("\x1b"); // Esc at the idle prompt neither stops nor quits anything.
  expect(interrupt).toHaveBeenCalledOnce();
  terminal.send("ab");
  terminal.send("\x04"); // With text, Ctrl+D edits instead of quitting.
  expect(onQuit).not.toHaveBeenCalled();
  terminal.send("\x7f");
  terminal.send("\x7f");
  terminal.send("\x04");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Press Ctrl+D again to quit");
  terminal.send("\x04");
  expect(onQuit).toHaveBeenCalledOnce();
  shell.stop();
});

// A command the operator approves must be readable whole: a hidden tail could be the dangerous part.
const longCommand = "git status --short; git log --oneline -5; find src tests -type f | sort; cat package.json; " +
  "ls docs docs/guide docs/design; rm -rf node_modules/.cache --verbose-final-marker";

it("shows an approval question whole, however long, with its answers", () => {
  const terminal = new TestTerminal();
  terminal.columns = 70;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.askIn("default", `Run \`${longCommand}\`? [y]es, [a]lways this session, [n]o: `).catch(() => undefined);
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("--verbose-final-marker`?");
  expect(screen).toContain("[n]o");
  shell.stop();
});

it("shows a command the agent runs whole in the conversation", () => {
  const terminal = new TestTerminal();
  terminal.columns = 70;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.showActivity("default", { type: "tool_started", call: "c1", tool: "bash", subject: longCommand });
  tui.renderNow(true);
  expect(visible(terminal)).toContain("--verbose-final-marker");
  shell.stop();
});

it("places workspace identity in the sidebar and execution context beside the prompt", () => {
  const terminal = new TestTerminal();
  terminal.columns = 120;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.setSessionExecution("default", "this computer · asks first");
  shell.setBranch("dev");
  shell.setSessionModel("default", "claude-code:opus");
  shell.addSession("second", "Session 2");
  shell.setSessionExecution("second", "sandbox · Docker");
  shell.start();
  tui.renderNow(true);
  const screen = visible(terminal);
  // Each session runs its commands where it chose; the footer names the selected session's.
  expect(screen).not.toContain("sandbox · Docker");
  expect(screen).toContain("tesota · dev");
  expect(screen).toContain("Session 1");
  expect(screen).toContain("this computer · asks first · claude-code:opus");
  expect(screen).not.toContain("this computer · asks first · tesota");
  terminal.writes.length = 0;
  terminal.send("\x1bb");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("tesota · dev / Session 1");
  shell.stop();
});

it("reflows the persistent layout after terminal resize", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.write("A long transcript line that must remain visible when the terminal becomes narrow.\n");
  terminal.resizeTo(44, 14);
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("A long transcript line that must");
  expect(screen).toContain("terminal becomes narrow.");
  shell.stop();
});

it("lets the operator scroll the persistent transcript with the keyboard", () => {
  const terminal = new TestTerminal();
  terminal.rows = 12;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  for (let index = 1; index <= 20; index++) shell.write(`Transcript entry ${index}\n`);
  tui.renderNow(true);
  terminal.writes.length = 0;

  terminal.send("\x1b[5~");
  tui.renderNow(true);

  expect(visible(terminal)).toContain("Transcript entry 1");
  shell.stop();
});

it("keeps input and decisions attached to the selected session", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 150;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.addSession("other", "Session 2");
  shell.start();
  const first = shell.askIn("default", "Approve these exact bytes? [y/N] ");
  terminal.send("\x1bj");
  const second = shell.askIn("other", "> ");
  terminal.send("hello");
  terminal.send("\r");
  await expect(second).resolves.toBe("hello");
  shell.writeTo("default", "Review is waiting in the first session.");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Session 1");
  expect(visible(terminal)).toContain("Idle");
  terminal.send("\x1bj");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Review is waiting in the first session.");
  terminal.send("n");
  terminal.send("\r");
  await expect(first).resolves.toBe("n");
  shell.stop();
});

it("moves back as well as forward between sessions, and jumps to the number the rail shows", () => {
  const terminal = new TestTerminal();
  terminal.columns = 110;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const selected: string[] = [];
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onSessionChange: (id) => { selected.push(id); } });
  shell.addSession("second", "Session 2");
  shell.addSession("third", "Session 3");
  shell.start();
  tui.renderNow(true);
  expect(visible(terminal)).toContain("1 Session 3");
  expect(visible(terminal)).toContain("3 Session 1");
  terminal.send("\x1bk"); // Alt+K follows the newest-first visual order.
  terminal.send("\x1b2"); // Alt+2
  terminal.send("\x1b9"); // No ninth session: nothing changes.
  terminal.send("\x1bj");
  terminal.send("\x1b1");
  expect(selected).toEqual(["second", "second", "default", "third"]);
  shell.askIn("third", "> ").catch(() => undefined);
  terminal.send("/help");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Alt+K previous");
  expect(visible(terminal)).toContain("Alt+1…9 by position");
  terminal.send("/previous");
  terminal.send("\r");
  expect(selected.at(-1)).toBe("default");
  shell.stop();
});

it("shows precise session needs inline and opens the rail as an overlay on narrow terminals", () => {
  const terminal = new TestTerminal();
  terminal.columns = 110;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.addSession("other", "Session 2");
  shell.start();
  shell.reportFor("other", { phase: "working" });
  shell.askIn("default", "Approve? [y/N] ").catch(() => undefined);
  tui.renderNow(true);
  expect(visible(terminal)).toContain("2 Session 1");
  expect(visible(terminal)).toContain("Needs you");
  expect(visible(terminal)).toContain("1 Session 2");
  expect(visible(terminal)).toContain("Working");
  // The selected session is highlighted as a selected command is; a state that needs the operator is in the warning color.
  const raw = terminal.writes.join("");
  const selection = "\x1b[48;2;75;61;83m";
  expect(screenLine(raw, "2 Session 1")).toContain(selection);
  expect(screenLine(raw, "1 Session 2")).not.toContain(selection);
  expect(raw).toContain("\x1b[38;2;213;179;106m! Needs you");
  expect(raw).not.toContain("●");

  terminal.writes.length = 0;
  terminal.send("\x1bb"); // Alt+B hides the rail without changing the selected session.
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("1 Session 2");
  expect(visible(terminal)).toContain("tesota / Session 1");

  terminal.send("\x1bb");
  terminal.resizeTo(70, 24);
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("1 Session 2");
  terminal.send("\x1bb");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("1 Session 2");
  shell.stop();
});

it("keeps Escape's stop behavior while the narrow sidebar overlay is open", () => {
  const terminal = new TestTerminal();
  terminal.columns = 70;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const interrupt = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, interrupt });
  shell.start();
  shell.report({ phase: "working" });
  terminal.send("\x1bb");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("1 Session 1");
  terminal.send("\x1b");
  expect(interrupt).toHaveBeenCalledOnce();
  shell.stop();
});

it("keeps the selected session visible when the sidebar has more rows than the terminal", () => {
  const terminal = new TestTerminal();
  terminal.columns = 110;
  terminal.rows = 12;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  for (let index = 2; index <= 9; index++) shell.addSession(`session-${index}`, `Session ${index}`);
  shell.start();
  tui.renderNow(true);
  expect(visible(terminal)).toContain("9 Session 1");
  shell.stop();
});

it("offers a view-only comparison while one session keeps input focus", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 190;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.addSession("other", "Research");
  shell.writeTo("other", "The other session found a source.");
  shell.start();
  const pending = shell.askIn("default", "> ");
  terminal.send("\x1bs");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Research · view only");
  expect(visible(terminal)).toContain("The other session found a source.");
  expect(visible(terminal)).toContain("2 Session 1");
  terminal.send("reply");
  terminal.send("\r");
  await expect(pending).resolves.toBe("reply");
  shell.stop();
});

it("shows source control bytes as text in the inspector", () => {
  const terminal = new TestTerminal();
  terminal.columns = 150;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, theme: "terminal" });
  shell.start();
  shell.inspect({ title: "Diff", summary: "Review the change", detail: "+ value = \"\x1b[2J\"" });
  tui.renderNow(true);
  expect(visible(terminal)).toContain("\\u001b[2J");
  shell.stop();
});

it("keeps the result accessible on a narrow terminal without moving the input target", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 70;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.inspect({ title: "Candidate result", summary: "A result is ready", detail: "Changed src/value.ts" });
  const answer = shell.ask("Accept? [y/N] ");
  terminal.send("\x1br"); // Alt+R: result panel, in place of the conversation at this width
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Changed src/value.ts");
  expect(visible(terminal)).toContain("Accept? [y/N]");
  terminal.send("\x1br"); // Alt+R again: back to the conversation
  terminal.send("n");
  terminal.send("\r");
  await expect(answer).resolves.toBe("n");
  shell.stop();
});

it("closes the selected session with Ctrl+W and moves input to the next one", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const closeRequests: string[] = [];
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    onCloseSession: (id) => { closeRequests.push(id); } });
  shell.start();
  shell.addSession("second", "Session 2");
  terminal.send("\x17");
  expect(closeRequests).toEqual(["default"]);
  const pending = shell.askIn("default", "> ");
  shell.removeSession("default");
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Session 2");
  expect(() => { shell.removeSession("second"); }).toThrow("last Tesota session");
  shell.stop();
});


function wideShell(options: { onEntry?: (id: string, entry: TranscriptEntry) => void } = {}) {
  const terminal = new TestTerminal();
  terminal.columns = 150;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, ...options });
  shell.start();
  const render = (): string => { terminal.writes.length = 0; tui.renderNow(true); return terminal.writes.join(""); };
  return { terminal, shell, render };
}

it("sets the operator's messages, the agent's replies and Tesota's notices apart", async () => {
  const { terminal, shell, render } = wideShell();
  const answer = shell.ask("> ");
  terminal.send("Fix the bug");
  terminal.send("\r");
  await answer;
  shell.showActivity("default", { type: "reply", message: 1, text: "Fixed **it**.", final: true });
  shell.write("Brought 1 newer change from your repository.");
  const rendered = render();
  // The operator's message sits on its own background; the agent's Markdown is rendered, not shown raw.
  const background = rendered.indexOf("\x1b[48;2;47;42;53m");
  expect(background).toBeGreaterThanOrEqual(0);
  expect(rendered.indexOf("Fix the bug", background)).toBeGreaterThan(background);
  expect(stripTerminalSequences(rendered)).toContain("Fixed it.");
  expect(stripTerminalSequences(rendered)).not.toContain("**it**");
  expect(rendered).toContain("\x1b[38;2;185;183;170mBrought 1 newer change");
  shell.stop();
});

it("grows one reply while it streams and records it once", () => {
  const entries: TranscriptEntry[] = [];
  const { shell, render } = wideShell({ onEntry: (_id, entry) => { entries.push(entry); } });
  shell.showActivity("default", { type: "reply", message: 1, text: "Reading the", final: false });
  shell.showActivity("default", { type: "reply", message: 1, text: "Reading the pricing code.", final: false });
  shell.showActivity("default", { type: "reply", message: 1, text: "Reading the pricing code.", final: true });
  const screen = stripTerminalSequences(render());
  expect(screen.split("Reading the").length - 1).toBe(1);
  expect(entries).toEqual([{ kind: "agent", text: "Reading the pricing code." }]);
  shell.stop();
});

it("shows each tool call with its command's last output lines and marks interrupted ones", async () => {
  const entries: TranscriptEntry[] = [];
  const { shell, render } = wideShell({ onEntry: (_id, entry) => { entries.push(entry); } });
  shell.showActivity("default", { type: "tool_started", call: "1", tool: "edit", subject: "src/price.ts" });
  shell.showActivity("default", { type: "tool_finished", call: "1", failed: false, output: "Applied edit" });
  shell.showActivity("default", { type: "tool_started", call: "2", tool: "bash", subject: "npm test" });
  shell.showActivity("default", { type: "tool_finished", call: "2", failed: true,
    output: "line 1\nline 2\nline 3\nline 4\nnot ok 1 discount" });
  shell.showActivity("default", { type: "tool_started", call: "3", tool: "bash", subject: "sleep 60" });
  shell.ask("> ").catch(() => undefined);
  const screen = stripTerminalSequences(render());
  expect(screen).toContain("• Edit src/price.ts");
  expect(screen).not.toContain("Applied edit");
  expect(screen).toContain("• Run npm test");
  expect(screen).toContain("└ … 1 earlier lines");
  expect(screen).toContain("not ok 1 discount");
  expect(screen).not.toContain("line 1\n");
  expect(screen).toContain("• Run sleep 60 (stopped)");
  expect(entries).toEqual([{ kind: "tool", tool: "edit", subject: "src/price.ts", failed: false },
    { kind: "tool", tool: "bash", subject: "npm test", failed: true }]);
  shell.stop();
});

it("shows and restores a successful edit's bounded inline patch", () => {
  const entries: TranscriptEntry[] = [];
  const first = wideShell({ onEntry: (_id, entry) => { entries.push(entry); } });
  const change = { added: 1, removed: 1, lines: ["@@ -1 +1 @@", "-old", "+new"] };
  first.shell.showActivity("default", { type: "tool_started", call: "edit-1", tool: "edit", subject: "src/a.ts" });
  first.shell.showActivity("default", { type: "tool_finished", call: "edit-1", failed: false,
    output: "Edited src/a.ts", change });
  expect(stripTerminalSequences(first.render())).toContain("• Edit src/a.ts (+1 −1)");
  expect(stripTerminalSequences(first.render())).toContain("-old");
  expect(entries).toEqual([{ kind: "tool", tool: "edit", subject: "src/a.ts", failed: false, change }]);
  first.shell.stop();

  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const restored = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    initialSession: { id: "default", title: "Session 1", entries } });
  restored.start();
  tui.renderNow(true);
  expect(visible(terminal)).toContain("• Edit src/a.ts (+1 −1)");
  expect(visible(terminal)).toContain("+new");
  restored.stop();
});

it("presents a review once in the conversation and its diff beside it on a wide terminal", () => {
  const entries: TranscriptEntry[] = [];
  const { shell, render } = wideShell({ onEntry: (_id, entry) => { entries.push(entry); } });
  shell.inspect({ title: "Review · 1 file", summary: "  edit   src/price.ts\n  ✓ npm test", detail: "Requested\n  1. Fix it",
    diff: "diff --git a/src/price.ts b/src/price.ts\n--- a/src/price.ts\n+++ b/src/price.ts\n@@ -2 +2 @@\n" +
      "-  return price + discount;\n+  return price - discount;" });
  const rendered = render();
  const screen = stripTerminalSequences(rendered);
  expect(screen.split("Review · 1 file").length - 1).toBe(2);
  expect(screen.split("✓ npm test").length - 1).toBe(1);
  expect(screen).toContain("1 file changed +1 -1");
  expect(screen).toContain("2 +   return price - discount;");
  expect(screen).toContain("2 -   return price + discount;");
  expect(rendered).toContain("\x1b[48;2;29;51;36m"); // The added row's tint.
  expect(entries).toEqual([{ kind: "review", title: "Review · 1 file", text: "  edit   src/price.ts\n  ✓ npm test" }]);
  shell.stop();
});

it("restores a recorded conversation with the same presentation", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, initialSession: { id: "default", title: "Session 1",
    entries: [{ kind: "user", text: "Earlier request" }, { kind: "tool", tool: "read", subject: "README.md", failed: false },
      { kind: "agent", text: "Earlier `answer`" }, { kind: "notice", text: "Applied to your repository.", tone: "success" }] } });
  shell.start();
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("Earlier request");
  expect(screen).toContain("• Read README.md");
  expect(screen).toContain("Earlier answer");
  expect(screen).toContain("Applied to your repository.");
  shell.stop();
});
