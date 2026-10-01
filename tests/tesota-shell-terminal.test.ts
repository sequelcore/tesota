import { HStack, stripTerminalSequences, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { commandQuestion, fullAccessQuestion } from "../src/session-decisions.js";
import { SHELL_SPINNER_FRAMES } from "../src/shell-progress.js";
import type { AccountsSource } from "../src/tesota-shell-accounts.js";
import { createTesotaShellTerminal, SessionBlockedError } from "../src/tesota-shell-terminal.js";
import { BackdropTui, FocusReportingTerminal } from "../src/tesota-shell-tui.js";
import { SessionRail } from "../src/tesota-shell-sidebar.js";
import { tesotaShellTheme } from "../src/tesota-shell-theme.js";
import { WelcomeBanner } from "../src/tesota-shell-welcome.js";
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
  readonly titles: string[] = [];
  setTitle(title: string): void { this.titles.push(title); }
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

it("shows the opening only for a newly created session and keeps it out of the saved conversation", () => {
  const freshTerminal = new TestTerminal();
  freshTerminal.columns = 100;
  freshTerminal.rows = 40;
  const freshTui = new TuiAltScreen(freshTerminal, false, undefined, { mouse: false });
  const onEntry = vi.fn();
  const fresh = createTesotaShellTerminal({ cwd: "work/tesota", tui: freshTui, onEntry });
  fresh.start();
  freshTui.renderNow(true);
  expect(visible(freshTerminal)).toContain("Every turn is reviewed; reverting never overwrites your edits.");
  expect(onEntry).not.toHaveBeenCalled();
  fresh.stop();

  const savedTerminal = new TestTerminal();
  savedTerminal.columns = 100;
  savedTerminal.rows = 40;
  const savedTui = new TuiAltScreen(savedTerminal, false, undefined, { mouse: false });
  const saved = createTesotaShellTerminal({ cwd: "work/tesota", tui: savedTui,
    initialSession: { id: "saved", title: "Saved", entries: [], fresh: false } });
  saved.start();
  savedTui.renderNow(true);
  expect(visible(savedTerminal)).not.toContain("Every turn is reviewed; reverting never overwrites your edits.");
  saved.stop();
});

it("turns the tree in an empty session while focused, and removes it at the first entry", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 100;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  const braille = /[⠁-⣿]/u;
  try {
    shell.start();
    tui.renderNow(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(visible(terminal)).toMatch(braille);
    terminal.writes.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(visible(terminal)).toMatch(braille);

    shell.setTerminalFocused(false);
    await new Promise((resolve) => setTimeout(resolve, 600));
    terminal.writes.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(visible(terminal)).not.toMatch(braille);

    shell.setTerminalFocused(true);
    shell.write("A first notice.");
    tui.renderNow(true);
    expect(visible(terminal)).toContain("A first notice.");
    terminal.writes.length = 0;
    tui.renderNow(true);
    expect(visible(terminal)).not.toMatch(braille);
    expect(visible(terminal)).toContain("Every turn is reviewed; reverting never overwrites your edits.");
  } finally {
    shell.stop();
  }
});

it("gives sidebar titles the space formerly used by position numbers", () => {
  const rail = new SessionRail(tesotaShellTheme());
  rail.setSessions([{ id: "current", title: "A descriptive session", state: "idle", selected: true }]);
  const [heading, state] = rail.render(25).map(stripTerminalSequences);
  expect(heading?.trimEnd()).toBe(" A descriptive session");
  expect(state?.trimEnd()).toBe("  · Idle");
  expect(heading).toHaveLength(25);
  expect(state).toHaveLength(25);
  expect(rail.rowFor("current")).toBe(0);
});

it("opens /themes, filters, navigates and switches without consuming the request", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 140;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const answer = shell.ask("> ");
  const screen = (): string => { terminal.writes.length = 0; tui.renderNow(true); return visible(terminal); };
  terminal.send("/themes");
  terminal.send("\r");
  const choices = screen();
  expect(choices).toContain("Theme: tesota-dark");
  for (const name of ["tesota-light", "vesper", "sequel", "automata", "phosphor", "terminal"]) {
    expect(choices).toContain(name);
  }
  terminal.send("\x1b[B");
  terminal.send("\r");
  expect(screen()).toContain("Theme: tesota-light.");
  terminal.send("/themes ves");
  const filtered = screen();
  expect(filtered).toContain("charcoal and peach");
  expect(filtered).not.toContain("parchment and ink");
  terminal.send("\t");
  terminal.send("\r");
  expect(screen()).toContain("Theme: vesper.");
  terminal.send("/themes automata");
  terminal.send("\x1b");
  expect(screen()).not.toContain("↑↓ choose");
  terminal.send("\x03");
  terminal.send("/themes");
  terminal.send("\r");
  expect(screen()).toContain("Theme: vesper");
  terminal.send("\x1b");
  terminal.send("\x03");
  terminal.send("/themes nonexistent");
  expect(screen()).toContain("No matching themes");
  terminal.send("\r");
  expect(screen()).toContain("No matching themes");
  terminal.send("\x03");
  terminal.send("continue");
  terminal.send("\r");
  await expect(answer).resolves.toBe("continue");
  shell.stop();
});

it("switches themes in place across sessions without answering the pending prompt", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 140;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.addSession("other", "Other", [{ kind: "notice", text: "Saved warning", tone: "warning" }]);
  shell.start();
  shell.write("Existing warning", "warning");
  const answer = shell.ask("> ");
  const send = (command: string): void => { terminal.send(command); terminal.send("\r"); tui.renderNow(true); };
  send("/themes tesota-light");
  expect(screenLine(terminal.writes.join(""), "Existing warning")).toContain("\x1b[38;2;110;96;44m");
  shell.selectSession("other");
  tui.renderNow(true);
  expect(screenLine(terminal.writes.join(""), "Saved warning")).toContain("\x1b[38;2;110;96;44m");
  shell.selectSession("default");
  send("/themes invalid extra");
  send("/themes terminal extra");
  expect(visible(terminal)).toContain("Theme: tesota-light");
  send("/themes terminal");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(terminal.writes.join("")).not.toContain("\x1b[38;2;");
  send("/themes tesota-dark");
  expect(screenLine(terminal.writes.join(""), "Existing warning")).toContain("\x1b[38;2;213;179;106m");
  send("continue");
  await expect(answer).resolves.toBe("continue");
  shell.stop();
});

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
  expect(visible(terminal)).toContain("Long notices");
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

it("lists multiple long notices newest first and opens the selected one", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 120;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.write("First notice:\nfirst a\nfirst b\nfirst c\nfirst d");
  shell.write("Second notice:\nsecond a\nsecond b\nsecond c\nsecond d");
  shell.ask("> ").catch(() => undefined);
  terminal.send("/details");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Second notice");
  terminal.send("\x1b[B");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("first c");
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

it("asks before Full access with its risk in the theme's warning color, and Enter cancels", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const question = shell.chooseIn("default", fullAccessQuestion);
  tui.renderNow(true);
  const warning = tesotaShellTheme("tesota-dark").warning!.slice(1).match(/../gu)!
    .map((hex) => Number.parseInt(hex, 16)).join(";");
  expect(visible(terminal)).toContain("Enable Full access?");
  expect(screenLine(terminal.writes.join(""), "significantly increases")).toContain(`[38;2;${warning}m`);
  terminal.send("\r");
  await expect(question).resolves.toBe("deny");
  shell.stop();
});

it("asks Full access's question over the idle request prompt, which waits again with the draft kept", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const request = shell.askIn("default", "> ");
  terminal.send("half a request");
  // Shift+Tab while idle: the question opens over the request prompt instead of failing.
  const allowed = shell.chooseIn("default", fullAccessQuestion);
  terminal.send("y");
  await expect(allowed).resolves.toBe("allow");
  // Esc cancels a second question, and the request prompt waits again.
  const cancelled = shell.chooseIn("default", fullAccessQuestion);
  terminal.send("\x1b");
  await expect(cancelled).rejects.toThrow("cancelled");
  terminal.send(" finished");
  terminal.send("\r");
  await expect(request).resolves.toBe("half a request finished");
  shell.stop();
});

it("refuses a question while another waits, and leaves the first one waiting", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const command = shell.chooseIn("default", commandQuestion({ command: "bun test" }));
  await expect(shell.chooseIn("default", fullAccessQuestion)).rejects.toThrow("prompt already active");
  terminal.send("y");
  await expect(command).resolves.toBe("once");
  shell.stop();
});

it("shows the shortcuts for ? on an empty input, and types it anywhere else", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.setSessionExecution("default", "›› accept edits on · sandbox · WSL", "sandbox");
  shell.start();
  const request = shell.ask("> ");
  terminal.send("?");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Shift+Tab mode");
  // Once something is typed, the hint leaves the footer and ? is part of the request.
  terminal.send("why?");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("? for shortcuts");
  terminal.send("\r");
  await expect(request).resolves.toBe("why?");
  shell.stop();
});

it("passes Shift+Tab to the shell as the selected session's permission mode switch", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onCycleMode = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onCycleMode });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  terminal.send("\x1b[Z");
  expect(onCycleMode).toHaveBeenCalledWith("default");
  shell.stop();
});

it("chooses a session sandbox from a filtered list without sending a request", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onSandbox = vi.fn();
  const sandboxPicker = () => ({ title: "Sandbox: default (auto)", entries: [
    { value: "default", label: "default", detail: "Follow auto" },
    { value: "wsl", label: "wsl", detail: "WSL sandbox" },
    { value: "docker", label: "docker", detail: "Docker Sandboxes" },
  ] });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onSandbox, sandboxPicker });
  shell.start();
  const answer = shell.ask("> ");
  terminal.send("/sandbox");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Sandbox: default (auto)");
  terminal.send("dock");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Docker Sandboxes");
  terminal.send("\r");
  expect(onSandbox).toHaveBeenCalledWith("default", "docker");
  terminal.send("continue");
  terminal.send("\r");
  await expect(answer).resolves.toBe("continue");
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

it("renames a session with /rename, asks for a suggestion without a name, and shows a new name", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onRename = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onRename });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  terminal.send("/rename Budget totals for March");
  terminal.send("\r");
  shell.ask("> ").catch(() => undefined);
  terminal.send("/rename");
  terminal.send("\r");
  expect(onRename.mock.calls).toEqual([["default", "Budget totals for March"], ["default", undefined]]);
  shell.setSessionTitle("default", "Budget totals for March");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(terminal.titles.at(-1)).toContain("Budget totals for March");
  shell.stop();
});

it("chooses a role's model with /roles: a role, then its model, which Enter sets", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onRoleModel = vi.fn();
  const prefixes: string[] = [];
  const modelPicker = (_id: string, prefix: string) => {
    prefixes.push(prefix);
    return prefix === "/roles "
      ? { title: "Role", completes: true, current: "", entries: [
        { id: "reviewer", detail: "codex:gpt-6-astra", reasoning: [] }, { id: "triage", detail: "codex:gpt-6-luna", reasoning: [] }] }
      : { title: "The triage's model, for every session", current: "codex:gpt-6-luna", entries: [
        { id: "typesafe:jev-1.13.0", detail: "your TypeSafe key", reasoning: [] },
        { id: "codex:gpt-6-luna", detail: "your ChatGPT plan's limits", reasoning: [] }] };
  };
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onRoleModel, modelPicker });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  const screen = (): string => { terminal.writes.length = 0; tui.renderNow(true); return visible(terminal); };
  terminal.send("/roles");
  terminal.send("\r");
  const roles = screen();
  expect(roles).toContain("Role · ↑↓ choose · Enter choose");
  expect(roles).not.toContain("←→ reasoning");
  terminal.send("tri");
  terminal.send("\r");
  // Choosing a role runs nothing: it opens that role's models.
  expect(onRoleModel).not.toHaveBeenCalled();
  expect(prefixes).toEqual(["/roles ", "/roles triage "]);
  const models = screen();
  expect(models).toContain("The triage's model, for every session");
  expect(models).toMatch(/● codex:gpt-6-luna/u);
  terminal.send("jev");
  terminal.send("\r");
  expect(onRoleModel).toHaveBeenCalledWith("default", ["triage", "typesafe:jev-1.13.0"]);
  // Typed in full, it runs without the picker.
  shell.ask("> ").catch(() => undefined);
  terminal.send("/roles triage off");
  terminal.send("\r");
  expect(onRoleModel).toHaveBeenLastCalledWith("default", ["triage", "off"]);
  shell.stop();
});

it("does not send a removed slash command to the agent", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const answer = shell.ask("> ");
  terminal.send("/models");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Unknown command");
  terminal.send("continue");
  terminal.send("\r");
  await expect(answer).resolves.toBe("continue");
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

it("moves once per key press when the terminal also reports releases", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  terminal.send("/");
  // Down pressed, then released, as the Kitty keyboard protocol reports them.
  terminal.send("\x1b[1;1:1B");
  terminal.send("\x1b[1;1:3B");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("› /next");
  shell.stop();
});

it("never renders a whole horizontal stack in a frame, whatever the conversation's length or the panels open", () => {
  // pi-tui sizes an HStack's columns by rendering each whole; an HStack inside a column made every frame composite the
  // entire conversation, 170 ms at 200 replies (findings, 2026-09-27).
  const terminal = new TestTerminal();
  terminal.columns = 200;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const entries: TranscriptEntry[] = Array.from({ length: 300 }, (_, index) => index % 2 === 0
    ? { kind: "agent", text: `Reply ${index} with **bold** text and \`code\`.` }
    : { kind: "tool", tool: "read", subject: `src/file-${index}.ts`, failed: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, initialSession: { id: "s", title: "Long", entries } });
  shell.start();
  shell.ask("> ").catch(() => undefined);
  tui.renderNow(true);
  const whole = vi.spyOn(HStack.prototype, "render");
  shell.refreshElapsed();
  tui.renderNow(false);
  shell.inspect({ title: "Review · 1 file", summary: "  edit   src/a.ts", detail: "Checks passed",
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new" });
  tui.renderNow(false);
  expect(visible(terminal)).toContain("Checks passed");
  terminal.send("\x1bs");
  tui.renderNow(false);
  expect(whole).not.toHaveBeenCalled();
  whole.mockRestore();
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
  // The session is named in the window title and the sidebar, never in a bar over the conversation.
  expect(screen).not.toContain("Session 1");
  expect(terminal.titles.at(-1)).toContain("Session 1");
  expect(screen).toContain("The repository is bounded.");
  expect(screen).toContain("Explain the shell");
  expect(screen).toContain("Ready");
  expect(screen).toContain("›");
  // A rule above and below the input sets it apart.
  expect(screen).toContain("─".repeat(20));
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
  expect(visible(terminal)).toContain("Session 1");
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

it("queues messages typed while the session works and hands them, in order, to its next request prompts", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onEntry = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onEntry });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("add a tax helper");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Enter queues it for after this turn · Tab sends it to the agent now");
  terminal.send("\r");
  terminal.send("then document it");
  terminal.send("\r");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("↳ add a tax helper");
  expect(visible(terminal)).toContain("↳ then document it");
  expect(shell.hasQueued("default")).toBe(true);
  // A queued message joins the conversation when it is sent, not when it is typed.
  expect(onEntry).not.toHaveBeenCalled();
  await expect(shell.askIn("default", "> ")).resolves.toBe("add a tax helper");
  // Only the request prompt takes them: a question during the next turn waits for its own answer.
  const question = shell.chooseIn("default", commandQuestion({ command: "bun test" }));
  terminal.send("y");
  await expect(question).resolves.toBe("once");
  await expect(shell.askIn("default", "> ")).resolves.toBe("then document it");
  expect(shell.hasQueued("default")).toBe(false);
  expect(onEntry.mock.calls.map(([, entry]) => entry)).toEqual([{ kind: "user", text: "add a tax helper" },
    { kind: "notice", text: "✓ Allowed `bun test` once.", tone: "info" }, { kind: "user", text: "then document it" }]);
  shell.stop();
});

it("sends a message to the working agent with Tab, and queues it when the agent cannot take one", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onSteer = vi.fn((_id: string, _text: string) => true);
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onSteer });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("use pnpm, not npm");
  terminal.send("\t");
  expect(onSteer).toHaveBeenCalledWith("default", "use pnpm, not npm");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("use pnpm, not npm");
  expect(shell.hasQueued("default")).toBe(false);
  onSteer.mockReturnValueOnce(false);
  terminal.send("and add a test");
  terminal.send("\t");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("The agent cannot take a message now; it is queued for after this turn.");
  expect(visible(terminal)).toContain("↳ and add a test");
  expect(shell.hasQueued("default")).toBe(true);
  shell.stop();
});

it("returns queued messages to the input when the work stops, rather than starting what was stopped", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const interrupt = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, interrupt });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("alpha");
  terminal.send("\r");
  terminal.send("bravo");
  terminal.send("\r");
  terminal.send("charlie");
  terminal.send("\x1b");
  expect(interrupt).toHaveBeenCalledOnce();
  expect(shell.hasQueued("default")).toBe(false);
  const next = shell.askIn("default", "> ");
  terminal.send("\r");
  await expect(next).resolves.toBe("alpha\nbravo\ncharlie");
  shell.stop();
});

it("keeps a shell command typed while the session works in the input, since it would change the running work", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onModel = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onModel });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("/model codex:gpt-6-sol");
  terminal.send("\r");
  tui.renderNow(true);
  expect(onModel).not.toHaveBeenCalled();
  expect(shell.hasQueued("default")).toBe(false);
  expect(visible(terminal)).toContain("Shell commands run at the prompt once this work ends");
  expect(visible(terminal)).toContain("/model codex:gpt-6-sol");
  shell.stop();
});

// A command the operator approves must be readable whole: a hidden tail could be the dangerous part.
const longCommand = "git status --short; git log --oneline -5; find src tests -type f | sort; cat package.json; " +
  "ls docs docs/guide docs/design; rm -rf node_modules/.cache --verbose-final-marker";

it("shows an approval question whole, however long, with its answers in place of the input", () => {
  const terminal = new TestTerminal();
  terminal.columns = 70;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.chooseIn("default", commandQuestion({ command: longCommand, reason: "Only your gh is signed in.", rule: ["git", "status"] }))
    .catch(() => undefined);
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("--verbose-final-marker` on this");
  expect(screen).toContain("Only your gh is signed in.");
  expect(screen).toContain("y  Yes, once");
  expect(screen).toContain("a  Always `git status …` in this repository");
  // Enter declines until another answer is chosen.
  expect(screen).toContain("→ n  No");
  expect(screen).toContain("Esc stop");
  shell.stop();
});

it("answers a question from its list or its keys, never from what is typed, and records the answer", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onEntry = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onEntry });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("draft");
  const declined = shell.chooseIn("default", commandQuestion({ command: "rm -rf dist" }));
  // Letters that are no answer, and Enter on the highlighted one, which starts on "No".
  terminal.send("x");
  terminal.send("\r");
  await expect(declined).resolves.toBe("deny");
  const allowed = shell.chooseIn("default", commandQuestion({ command: "gh pr list", rule: ["gh", "pr"] }));
  terminal.send("\x1b[A");
  terminal.send("\r");
  await expect(allowed).resolves.toBe("rule");
  expect(onEntry.mock.calls.map(([, entry]) => entry)).toEqual([
    { kind: "notice", text: "✗ Declined `rm -rf dist`; the command did not run.", tone: "warning" },
    { kind: "notice", text: "✓ Allowed `gh pr list`; always allow `gh pr …` in this repository.", tone: "info" }]);
  // The draft typed before the questions is still in the input, and nothing typed during them joined it.
  tui.renderNow(true);
  expect(visible(terminal)).toContain("draft");
  expect(visible(terminal)).not.toContain("draftx");
  shell.stop();
});

it("stops the work with Esc at a question, leaving the draft in the input", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.reportFor("default", { phase: "working" });
  terminal.send("keep this");
  const question = shell.chooseIn("default", commandQuestion({ command: "bun test" }));
  terminal.send("\x1b");
  await expect(question).rejects.toThrow("cancelled");
  const next = shell.askIn("default", "> ");
  terminal.send("\r");
  await expect(next).resolves.toBe("keep this");
  shell.stop();
});

it.each([60, 240])("keeps choices visible in a short terminal %i columns wide and scrolls the whole command with Ctrl+PageDown", async (columns) => {
  const terminal = new TestTerminal();
  terminal.columns = columns;
  terminal.rows = 16;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.addSession("second", "Comparison task");
  terminal.send("\x1bs");
  const question = shell.chooseIn("default", commandQuestion({
    command: `${"echo long-command; ".repeat(100)}dangerous-final-marker`,
  }));
  tui.renderNow(true);
  expect(visible(terminal)).toContain("→ n  No");
  expect(visible(terminal)).not.toContain("dangerous-final-marker");
  for (let page = 0; page < 100; page += 1) {
    terminal.send("\x1b[6;5~");
    tui.renderNow(true);
  }
  expect(visible(terminal)).toContain("dangerous-final-marker");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("→ n  No");
  terminal.send("\r");
  await expect(question).resolves.toBe("deny");
  shell.stop();
});

it("answers only the selected session's question, with plain and Kitty keys, keeping drafts and history", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onEntry = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onEntry });
  shell.start();
  terminal.send("first draft");
  const first = shell.chooseIn("default", commandQuestion({ command: "bun test" }));
  let answered = false;
  first.then(() => { answered = true; });
  shell.addSession("second", "Other task");
  shell.selectSession("second");
  terminal.send("second draft");
  const second = shell.chooseIn("second", commandQuestion({ command: "git status" }));
  terminal.send("\x1b[121u");
  await expect(second).resolves.toBe("once");
  expect(answered).toBe(false);
  shell.selectSession("default");
  // An unavailable shortcut, pasted text and a modified key never approve.
  terminal.send("a");
  terminal.send("yes");
  terminal.send("\x1b[121;5u");
  await Promise.resolve();
  expect(answered).toBe(false);
  terminal.send("Y");
  await expect(first).resolves.toBe("once");
  const request = shell.askIn("default", "> ");
  terminal.send("\r");
  await expect(request).resolves.toBe("first draft");
  const recalled = shell.askIn("default", "> ");
  terminal.send("\x1b[A");
  terminal.send("\r");
  await expect(recalled).resolves.toBe("first draft");
  shell.selectSession("second");
  const otherRequest = shell.askIn("second", "> ");
  terminal.send("\r");
  await expect(otherRequest).resolves.toBe("second draft");
  expect(onEntry.mock.calls.filter(([, entry]) => entry.kind === "notice").map(([id]) => id)).toEqual(["second", "default"]);
  shell.stop();
});

it("rejects a pending choice when its session is blocked or closed, leaving other sessions waiting", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  shell.addSession("second", "Other task");
  const blocked = shell.chooseIn("default", commandQuestion({ command: "bun test" }));
  const closed = shell.chooseIn("second", commandQuestion({ command: "git status" }));
  shell.blockSession("default");
  await expect(blocked).rejects.toBeInstanceOf(SessionBlockedError);
  shell.selectSession("second");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Run `git status`?");
  shell.removeSession("second");
  await expect(closed).rejects.toThrow("closed");
  await expect(shell.chooseIn("default", commandQuestion({ command: "bun test" }))).rejects.toBeInstanceOf(SessionBlockedError);
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

it("keeps the status line to one row for a command that spans lines, as a heredoc does, and shows the command whole once", () => {
  const terminal = new TestTerminal();
  terminal.columns = 100;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const heredoc = "cat .gitignore; cat > package.json <<'E'\n{\n  \"name\": \"dowser\",\n  \"type\": \"module\"\n}\nE";
  shell.showActivity("default", { type: "tool_started", call: "c1", tool: "bash", subject: heredoc });
  // Each spinner frame draws the status line again; it must not spill the command's other lines into the layout.
  for (let frame = 0; frame < 4; frame += 1) { shell.refreshElapsed(); tui.renderNow(); }
  terminal.writes.length = 0;
  tui.renderNow(true);
  const screen = stripTerminalSequences(terminal.writes.join(""));
  expect(screen).toContain("Running cat .gitignore; cat > package.json <<'E' …");
  // The transcript shows the command whole, once; the status line shows only its first line.
  expect(screen.split("\"name\": \"dowser\"").length - 1).toBe(1);
  shell.stop();
});

it("names the model, repository and branch under the prompt, then the mode and where commands run, in its color", () => {
  const terminal = new TestTerminal();
  terminal.columns = 120;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.setSessionExecution("default", "this computer · asks first", "host");
  shell.setBranch("dev");
  shell.setSessionModel("default", "claude-code:opus");
  shell.addSession("second", "Session 2");
  shell.setSessionExecution("second", "sandbox · Docker", "sandbox");
  shell.start();
  terminal.writes.length = 0;
  tui.renderNow(true);
  const screen = visible(terminal);
  // Each session runs its commands where it chose; the footer names the selected session's.
  expect(screen).not.toContain("sandbox · Docker");
  expect(screen).toContain("tesota · dev");
  expect(screen).toContain("Session 1");
  // The model first, then the repository and branch, as Claude Code and Codex show them, whether or not the sidebar shows.
  const raw = terminal.writes.join("");
  const theme = tesotaShellTheme("tesota-dark");
  expect(stripTerminalSequences(screenLine(raw, "claude-code:opus")).trim()).toBe("claude-code:opus · tesota · dev");
  // The mode's line ends with the keys that cycle it and, while the input is empty, show the shortcuts.
  expect(stripTerminalSequences(screenLine(raw, "this computer · asks first")))
    .toContain("this computer · asks first (shift+tab to cycle) · ? for shortcuts");
  // This computer in the theme's caution color, a sandbox in its success color.
  const warning = theme.warning!.slice(1).match(/../gu)!.map((hex) => Number.parseInt(hex, 16)).join(";");
  expect(screenLine(raw, "this computer · asks first")).toContain(`[38;2;${warning}mthis computer · asks first`);
  // The input stands between two rules.
  expect(screen.match(/─{20,}/gu)?.length).toBe(2);
  terminal.writes.length = 0;
  terminal.send("b");
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("Session 1");
  expect(visible(terminal)).toContain("claude-code:opus · tesota · dev");
  shell.selectSession("second");
  terminal.writes.length = 0;
  tui.renderNow(true);
  const success = theme.success!.slice(1).match(/../gu)!.map((hex) => Number.parseInt(hex, 16)).join(";");
  expect(screenLine(terminal.writes.join(""), "sandbox · Docker")).toContain(`\x1b[38;2;${success}msandbox · Docker`);
  shell.stop();

  // A terminal too narrow for the sidebar hides it too, and the prompt's line names the workspace until it widens.
  const narrow = new TestTerminal();
  narrow.columns = 70;
  const narrowTui = new TuiAltScreen(narrow, false, undefined, { mouse: false });
  const narrowShell = createTesotaShellTerminal({ cwd: "work/tesota", tui: narrowTui });
  narrowShell.setBranch("dev");
  narrowShell.setSessionModel("default", "claude-code:opus");
  narrowShell.start();
  narrowTui.renderNow(true);
  expect(visible(narrow)).toContain("claude-code:opus · tesota · dev");
  narrow.resizeTo(120, 24);
  narrow.writes.length = 0;
  narrowTui.renderNow(true);
  expect(visible(narrow)).toContain("claude-code:opus · tesota · dev");
  narrowShell.stop();
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

it("moves back as well as forward between sessions, and jumps by newest-first position without a visible number", () => {
  const terminal = new TestTerminal();
  terminal.columns = 110;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const selected: string[] = [];
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onSessionChange: (id) => { selected.push(id); } });
  shell.addSession("second", "Session 2");
  shell.addSession("third", "Session 3");
  shell.start();
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Session 3");
  expect(visible(terminal)).not.toContain("1 Session 3");
  expect(visible(terminal)).not.toContain("3 Session 1");
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
  expect(visible(terminal)).toContain("Session 1");
  expect(visible(terminal)).toContain("Needs you");
  expect(visible(terminal)).toContain("Session 2");
  expect(visible(terminal)).toContain("Working");
  // The selected session is highlighted as a selected command is; a state that needs the operator is in the warning color.
  const raw = terminal.writes.join("");
  const selection = "\x1b[48;2;75;61;83m";
  expect(screenLine(raw, "Session 1")).toContain(selection);
  expect(screenLine(raw, "Session 2")).not.toContain(selection);
  expect(raw).toContain("\x1b[38;2;213;179;106m! Needs you");
  expect(raw).not.toContain("●");

  terminal.writes.length = 0;
  terminal.send("\x1bb"); // Alt+B hides the rail without changing the selected session.
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("Session 2");
  expect(visible(terminal)).not.toContain("Session 1");

  terminal.send("\x1bb");
  terminal.resizeTo(70, 24);
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Session 2");
  terminal.send("\x1bb");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("Session 2");
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
  expect(visible(terminal)).toContain("Session 1");
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
  expect(visible(terminal)).toContain("Session 1");
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
  expect(visible(terminal)).toContain("Session 1");
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
  expect(terminal.titles.at(-1)).toContain("Session 2");
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

it("presents a review once in the conversation and its diff beside it on a wide terminal, on its own tab", () => {
  const entries: TranscriptEntry[] = [];
  const { terminal, shell, render } = wideShell({ onEntry: (_id, entry) => { entries.push(entry); } });
  shell.inspect({ title: "Review · 1 file", summary: "  edit   src/price.ts\n  ✓ npm test", detail: "Requested\n  1. Fix it",
    diff: "diff --git a/src/price.ts b/src/price.ts\n--- a/src/price.ts\n+++ b/src/price.ts\n@@ -2 +2 @@\n" +
      "-  return price + discount;\n+  return price - discount;" });
  const review = stripTerminalSequences(render());
  expect(review.split("Review · 1 file").length - 1).toBe(2);
  expect(review.split("✓ npm test").length - 1).toBe(1);
  // The review opens on its record; with no checks recorded, its only other tab is the diff.
  expect(review).toContain(" Review  Diff ");
  expect(review).not.toContain(" Checks ");
  expect(review).toContain("1. Fix it");
  expect(review).not.toContain("1 file changed");
  terminal.send("\x1bt");
  const rendered = render();
  const screen = stripTerminalSequences(rendered);
  expect(screen).not.toContain("1. Fix it");
  expect(screen).toContain("1 file changed +1 -1");
  expect(screen).toContain("2 +   return price - discount;");
  expect(screen).toContain("2 -   return price + discount;");
  expect(rendered).toContain("\x1b[48;2;29;51;36m"); // The added row's tint.
  expect(entries).toEqual([{ kind: "review", title: "Review · 1 file", text: "  edit   src/price.ts\n  ✓ npm test" }]);
  shell.stop();
});

/** The rows of a full frame, as the TUI draws each after moving to its start; `undefined` for a row not drawn. */
function frameRows(frame: string): string[] {
  const rows: string[] = [];
  // Each row starts at ESC [ row ;1H; the text before the first is the frame's own setup.
  let row: number | undefined;
  for (const part of frame.split("\x1b[")) {
    const start = /^(\d+);1H/u.exec(part);
    if (start !== null) row = Number(start[1]) - 1;
    if (row !== undefined) rows[row] = start === null ? `${rows[row] ?? ""}\x1b[${part}` : part.slice(start[0].length);
  }
  return rows;
}

/** Click the first drawn `text` with the left button, as a terminal or a phone's SSH client reports a tap. */
function clickText(terminal: TestTerminal, frame: string, text: string): void {
  const rows = frameRows(frame).map((row) => stripTerminalSequences(row ?? ""));
  const row = rows.findIndex((line) => line.includes(text));
  expect(row, `${text} on screen`).toBeGreaterThanOrEqual(0);
  const column = (rows[row] ?? "").indexOf(text) + 1;
  terminal.send(`\x1b[<0;${column + 1};${row + 1}M`);
  terminal.send(`\x1b[<0;${column + 1};${row + 1}m`);
}

it("steps through a result's tabs with Alt+T or a click, each keeping its own place, and starts a new result on Review", () => {
  const terminal = new TestTerminal();
  terminal.columns = 150;
  terminal.rows = 30;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const render = (): string => { terminal.writes.length = 0; tui.renderNow(true); return terminal.writes.join(""); };
  const output = Array.from({ length: 80 }, (_, index) => `    │ line ${index}`).join("\n");
  shell.inspect({ title: "Review · 1 file", summary: "  edit   src/a.ts",
    detail: `Your requests\n  1. Fix it\n\nChecks\n  ✓ passed (exit 0): npm test\n${output}\n\nReview\n  advisor\n    Looks right`,
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new" });
  let frame = stripTerminalSequences(render());
  expect(frame).toContain(" Review  Checks  Diff ");
  expect(frame).toContain("Alt+T");
  // The Review tab holds the record without its checks.
  expect(frame).toContain("Looks right");
  expect(frame).not.toContain("npm test");
  terminal.send("\x1bt");
  frame = stripTerminalSequences(render());
  expect(frame).toContain("✓ passed (exit 0): npm test");
  expect(frame).not.toContain("Looks right");
  // Scrolled to the checks' end, the Checks tab keeps its place while another tab is shown.
  for (let step = 0; step < 60; step += 1) terminal.send("\x1b[<65;120;20M");
  frame = stripTerminalSequences(render());
  expect(frame).toContain("line 79");
  clickText(terminal, render(), " Diff ");
  frame = stripTerminalSequences(render());
  expect(frame).toContain("1 file changed +1 -1");
  expect(frame).not.toContain("line 79");
  clickText(terminal, render(), " Checks ");
  frame = stripTerminalSequences(render());
  expect(frame).toContain("line 79");
  expect(frame).not.toContain("npm test");
  // A click elsewhere in the tab row chooses nothing.
  clickText(terminal, render(), "Alt+T");
  expect(stripTerminalSequences(render())).toContain("line 79");
  // A new result opens on its Review tab, from the start.
  shell.inspect({ title: "Answer check", summary: "No files changed.", detail: "Your requests\n  1. Explain it\n\nReview\n  None" });
  frame = stripTerminalSequences(render());
  expect(frame).toContain("1. Explain it");
  // An answer has only its review, so there are no tabs to choose.
  expect(frame).not.toContain("Alt+T");
  shell.stop();
});

it("selects a session clicked in the sidebar, as Alt+J does", () => {
  const terminal = new TestTerminal();
  terminal.columns = 150;
  terminal.rows = 30;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.addSession("second", "Other task");
  shell.start();
  const render = (): string => { terminal.writes.length = 0; tui.renderNow(true); return terminal.writes.join(""); };
  const selection = "\x1b[48;2;75;61;83m";
  const rowOf = (frame: string, text: string): string =>
    frameRows(frame).find((row) => stripTerminalSequences(row ?? "").includes(text)) ?? "";
  let frame = render();
  expect(rowOf(frame, "Other task")).not.toContain(selection);
  // The session's second row, its state, selects it too.
  const rows = frameRows(frame).map((row) => stripTerminalSequences(row ?? ""));
  const below = rows.findIndex((line) => line.includes("Other task")) + 1;
  terminal.send(`\x1b[<0;4;${below + 1}M`);
  terminal.send(`\x1b[<0;4;${below + 1}m`);
  frame = render();
  expect(rowOf(frame, "Other task")).toContain(selection);
  expect(rowOf(frame, "Session 1")).not.toContain(selection);
  clickText(terminal, frame, "Session 1");
  expect(rowOf(render(), "Session 1")).toContain(selection);
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

it("shows the selected session's plan above the prompt, and nothing once it is cleared", () => {
  const terminal = new TestTerminal();
  terminal.columns = 120;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.setSessionPlan("default", [{ step: "Update the totals", status: "done", check: "recalculates with zero errors" },
    { step: "Write the summary", status: "in_progress" }]);
  shell.addSession("second", "Session 2");
  shell.setSessionPlan("second", [{ step: "Another session's step", status: "pending" }]);
  shell.start();
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("Plan · 1 of 2 done");
  expect(screen).toContain("Update the totals · done (agent) · check not run: recalculates with zero errors");
  expect(screen).toContain("Write the summary · in progress");
  expect(screen).not.toContain("Another session's step");
  shell.setSessionPlan("default", undefined);
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("Plan ·");
  shell.stop();
});

it("titles the terminal with the selected session's mark and name, and only when they change", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    initialSession: { id: "default", title: "Fix\u0007 the\nlogin", entries: [] } });
  shell.start();
  // A control character would end the title's escape sequence early; it is shown as text instead.
  expect(terminal.titles).toEqual(["· Fix\\u0007 the login"]);
  shell.setSessionTitle("default", "Budget totals");
  shell.refreshElapsed();
  expect(terminal.titles.at(-1)).toBe("· Budget totals");
  shell.report({ phase: "working" });
  expect(terminal.titles.at(-1)).toBe(`${SHELL_SPINNER_FRAMES[0]} Budget totals`);
  shell.report({ phase: "awaiting_decision" });
  expect(terminal.titles.at(-1)).toBe("! Budget totals");
  const written = terminal.titles.length;
  shell.refreshElapsed();
  expect(terminal.titles).toHaveLength(written);
  shell.addSession("second", "Second task");
  shell.selectSession("second");
  // The first session still awaits a decision in the background.
  expect(terminal.titles.at(-1)).toBe("! Second task · 1 waiting");
  shell.stop();
  expect(terminal.titles.at(-1)).toBe("Tesota");
});

it("marks the title for a background session that waits, without taking the selected session's name", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    initialSession: { id: "default", title: "Budget totals", entries: [] } });
  shell.start();
  shell.addSession("second", "Login fix");
  shell.addSession("third", "Docs pass");
  shell.selectSession("default");
  expect(terminal.titles.at(-1)).toBe("· Budget totals");
  shell.reportFor("second", { phase: "working" });
  expect(terminal.titles.at(-1)).toBe(`${SHELL_SPINNER_FRAMES[0]} Budget totals`);
  shell.askIn("second", "Allow network access? [y/N] ").catch(() => undefined);
  expect(terminal.titles.at(-1)).toBe("! Budget totals · 1 waiting");
  shell.reportFor("third", { phase: "awaiting_decision" });
  expect(terminal.titles.at(-1)).toBe("! Budget totals · 2 waiting");
  shell.report({ phase: "awaiting_decision" });
  expect(terminal.titles.at(-1)).toBe("! Budget totals · 2 waiting");
  shell.selectSession("second");
  expect(terminal.titles.at(-1)).toBe("! Login fix · 2 waiting");
  shell.removeSession("second");
  expect(terminal.titles.at(-1)).toMatch(/^! (Budget totals|Docs pass) · 1 waiting$/u);
  shell.stop();
});

it("lists sessions waiting on the operator first, keeps newest-first otherwise, and counts them in the footer when the sidebar hides", () => {
  const terminal = new TestTerminal();
  terminal.columns = 120;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui,
    initialSession: { id: "default", title: "Budget totals", entries: [] } });
  shell.addSession("second", "Login fix");
  shell.addSession("third", "Docs pass");
  shell.start();
  const order = (): number[] => ["Budget totals", "Login fix", "Docs pass"].map((title) => visible(terminal).indexOf(title));
  terminal.writes.length = 0;
  tui.renderNow(true);
  const [budget, login, docs] = order();
  expect(docs).toBeLessThan(login ?? 0);
  expect(login).toBeLessThan(budget ?? 0);
  // The oldest session waits on the operator: it rises to the top, and Alt+1 selects it.
  shell.reportFor("default", { phase: "awaiting_decision" });
  terminal.writes.length = 0;
  tui.renderNow(true);
  const [waiting, second, newest] = order();
  expect(waiting).toBeLessThan(newest ?? 0);
  expect(newest).toBeLessThan(second ?? 0);
  shell.selectSession("third");
  terminal.send("1");
  expect(terminal.titles.at(-1)).toMatch(/Budget totals/u);
  // With the sidebar visible its marks show who waits; the footer counts them only once it hides.
  expect(visible(terminal)).not.toContain("needs you");
  terminal.resizeTo(70, 24);
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("1 needs you");
  shell.stop();
});

it("opens the Accounts panel over the session: its tabs, keys that never reach the prompt, and a role's model through /roles", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 120;
  terminal.rows = 30;
  const tui = new BackdropTui(terminal, false, undefined, { mouse: false });
  const reads = { usage: 0, signIns: 0 };
  const accounts: AccountsSource = {
    readUsage: async (update) => {
      reads.usage += 1;
      update([{ route: "codex", kind: "codex", state: "reading" }]);
      update([{ route: "codex", kind: "codex", state: "read", reading: { plan: "plus", notes: [],
        meters: [{ label: "week", left: 20 }] } }]);
    },
    readSignIns: async () => {
      reads.signIns += 1;
      return { rows: [{ route: "codex", kind: "Codex", signIn: "signed in" }], usedBy: () => ["reviewer"] };
    },
    roles: () => [{ role: "agent", choice: "claude-code:sonnet", route: "claude-code" }, { role: "reviewer", choice: "codex:gpt-6-astra",
      route: "codex" }, { role: "advisor", choice: "off" }],
  };
  const modelPicker = () => ({ current: "codex:gpt-6-astra", entries: [{ id: "codex:gpt-6-sol", detail: "plan", reasoning: [] }] });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, accounts, modelPicker });
  shell.start();
  const answer = shell.ask("> ");
  const screen = async (): Promise<string> => {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    terminal.writes.length = 0;
    tui.renderNow(true);
    return visible(terminal);
  };
  terminal.send("/usage");
  terminal.send("\r");
  const usage = await screen();
  expect(usage).toContain("Accounts");
  expect(screenLine(terminal.writes.join(""), "Session 1")).toContain("[2m");
  expect(usage).toMatch(/1 Usage {3}2 Sign-ins {3}3 Roles/u);
  expect(usage).toMatch(/codex {2}Codex plus {2}week {4}████░░░░░░░░░░░░░░░░ {2}20%/u);
  expect(usage).toContain("read just now");
  // Typing while the panel is open reaches the panel, not the request.
  terminal.send("x");
  terminal.send("\t");
  const signIns = await screen();
  expect(signIns).toMatch(/codex {2}Codex {2}signed in {2}— +reviewer/u);
  terminal.send("3");
  terminal.send("\x1b[B");
  expect(await screen()).toMatch(/› reviewer {2}codex:gpt-6-astra {3}codex {8}██░░░░░░░░ {2}20% {2}week/u);
  terminal.send("r");
  await screen();
  expect(reads).toEqual({ usage: 2, signIns: 2 });
  // Enter closes the panel and opens the role's model picker, as /roles reviewer does.
  terminal.send("\r");
  const picker = await screen();
  expect(picker).not.toContain("1 Usage");
  expect(picker).toContain("codex:gpt-6-sol");
  terminal.send("\x1b");
  terminal.send("\x1b");
  await screen();
  for (let key = 0; key < "/roles reviewer ".length; key += 1) terminal.send("\x7f");
  terminal.send("done");
  terminal.send("\r");
  await expect(answer).resolves.toBe("done");
  terminal.send("\x1ba");
  expect(await screen()).toContain("1 Usage");
  terminal.send("\x1b");
  expect(await screen()).not.toContain("1 Usage");
  // The layout beneath is faint only while the panel is open.
  expect(screenLine(terminal.writes.join(""), "Session 1")).not.toContain("[2m");
  shell.stop();
});

it("passes /keep, /revert with its choice, /redo and /checks to the shell, and keeps the prompt waiting", () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onKeep = vi.fn();
  const onRevert = vi.fn();
  const onRedo = vi.fn();
  const onChecks = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onKeep, onRevert, onRedo, onChecks });
  shell.start();
  let answered = false;
  shell.ask("> ").then(() => { answered = true; }, () => undefined);
  for (const command of ["/keep", "/revert", "/revert all", "/revert agent", "/redo", "/checks", "/checks reset"]) {
    terminal.send(command);
    terminal.send("\r");
  }
  expect(onKeep).toHaveBeenCalledWith("default");
  expect(onRevert.mock.calls).toEqual([["default", []], ["default", ["all"]], ["default", ["agent"]]]);
  expect(onRedo).toHaveBeenCalledWith("default");
  expect(onChecks.mock.calls).toEqual([["default", []], ["default", ["reset"]]]);
  expect(answered).toBe(false);
  shell.stop();
});

it("ends a waiting prompt when its session is blocked, as after a revert that needs recovery", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.start();
  const waiting = shell.ask("> ");
  shell.blockSession("default");
  await expect(waiting).rejects.toBeInstanceOf(SessionBlockedError);
  await expect(shell.ask("> ")).rejects.toBeInstanceOf(SessionBlockedError);
  shell.stop();
});

it("reads the terminal's focus reports on their way to pi-tui, which consumes them", () => {
  const inner = new TestTerminal();
  const terminal = new FocusReportingTerminal(inner);
  const focus: boolean[] = [];
  const input: string[] = [];
  terminal.onFocusChange((focused) => { focus.push(focused); });
  terminal.start((data) => { input.push(data); }, () => {});
  inner.send("\x1b[O");
  inner.send("a");
  inner.send("\x1b[I");
  expect(focus).toEqual([false, true]);
  expect(input).toEqual(["\x1b[O", "a", "\x1b[I"]);
});

it("hands a click in the middle of an empty session to its tree", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 100;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  const handled = vi.spyOn(WelcomeBanner.prototype, "handleMouse");
  try {
    shell.start();
    tui.renderNow(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    tui.renderNow(true);
    terminal.send("\x1b[<0;62;15M");
    terminal.send("\x1b[<0;62;15m");
    expect(handled.mock.results.some((result) => result.value?.handled === true)).toBe(true);
  } finally {
    handled.mockRestore();
    shell.stop();
  }
});

it("answers shell commands without saving the answer or ending the opening, which makes room for it", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 100;
  terminal.rows = 40;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onEntry = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onEntry });
  const braille = /[⠁-⣿]/u;
  try {
    shell.start();
    shell.ask("> ").catch(() => {});
    tui.renderNow(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const command of ["/themes vesper", "/nonsense"]) {
      for (const key of command) terminal.send(key);
      terminal.send("\r");
    }
    shell.replyTo("default", "A listing the operator asked for.");
    terminal.writes.length = 0;
    tui.renderNow(true);
    const screen = visible(terminal);
    expect(screen).toMatch(braille);
    expect(screen).toContain("Theme: vesper.");
    expect(screen).toContain("Unknown command.");
    expect(screen).toContain("A listing the operator asked for.");
    expect(screen).toContain("Every turn is reviewed; reverting never overwrites your edits.");
    expect(onEntry).not.toHaveBeenCalled();

    shell.write("Commands in this session will run in WSL.");
    terminal.writes.length = 0;
    tui.renderNow(true);
    expect(visible(terminal)).not.toMatch(braille);
    expect(onEntry).toHaveBeenCalledWith(expect.any(String), { kind: "notice", text: "Commands in this session will run in WSL.", tone: "info" });
    expect(onEntry).toHaveBeenCalledTimes(1);
  } finally {
    shell.stop();
  }
});
