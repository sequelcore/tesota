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
  await new Promise((resolve) => setTimeout(resolve, 10));
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Start a session");
  terminal.send("new");
  terminal.send("\r");
  expect(onNewSession).toHaveBeenCalledOnce();
  terminal.send("actual request");
  terminal.send("\r");
  await expect(answer).resolves.toBe("actual request");
  shell.stop();
});

it("uses the typed slash command when autocomplete has a stale selection", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const onNewSession = vi.fn();
  const onCloseSession = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui, onNewSession, onCloseSession });
  shell.start();
  const answer = shell.ask("> ");
  terminal.send("/");
  await new Promise((resolve) => setTimeout(resolve, 10));
  terminal.send("close");
  terminal.send("\r");
  expect(onCloseSession).toHaveBeenCalledWith("default");
  expect(onNewSession).not.toHaveBeenCalled();
  terminal.send("request");
  terminal.send("\r");
  await expect(answer).resolves.toBe("request");
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
  expect(screen).toContain("tesota · Session 1");
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
  expect(visible(terminal)).toContain("● Session 1");
  expect(visible(terminal)).toContain("preparing");
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
  expect(visible(terminal)).toContain("idle");
  terminal.send("\x1bj");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Review is waiting in the first session.");
  terminal.send("n");
  terminal.send("\r");
  await expect(first).resolves.toBe("n");
  shell.stop();
});

it("shows session needs in a rail that can be hidden and collapses on narrow terminals", () => {
  const terminal = new TestTerminal();
  terminal.columns = 110;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "work/tesota", tui });
  shell.addSession("other", "Session 2");
  shell.start();
  shell.reportFor("other", { phase: "working" });
  shell.askIn("default", "Approve? [y/N] ").catch(() => undefined);
  tui.renderNow(true);
  expect(visible(terminal)).toContain("● Session 1");
  expect(visible(terminal)).toContain("needs you");
  expect(visible(terminal)).toContain("● Session 2");
  expect(visible(terminal)).toContain("working");

  terminal.writes.length = 0;
  terminal.send("\x1bb"); // Alt+B hides the rail without changing the selected session.
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("● Session 2");
  expect(visible(terminal)).toContain("tesota · Session 1");

  terminal.send("\x1bb");
  terminal.resizeTo(70, 24);
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).not.toContain("● Session 2");
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
  shell.selectSession("session-9");
  terminal.writes.length = 0;
  tui.renderNow(true);
  expect(visible(terminal)).toContain("● Session 9");
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
  expect(visible(terminal)).toContain("● Session 1");
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
  shell.inspect({ title: "Review · 1 file", summary: "  edit   src/price.ts\n  ✓ npm test",
    detail: "Diff\n-  return price + discount;\n+  return price - discount;" });
  const rendered = render();
  const screen = stripTerminalSequences(rendered);
  expect(screen.split("Review · 1 file").length - 1).toBe(2);
  expect(screen.split("✓ npm test").length - 1).toBe(1);
  expect(screen).toContain("+  return price - discount;");
  expect(rendered).toContain("\x1b[38;2;154;176;143m+  return price - discount;");
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
