import { stripTerminalSequences, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { expect, it, vi } from "vitest";
import { createTesotaShellTerminal } from "../src/tesota-shell-terminal.js";

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
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui });
  shell.start();
  for (let index = 0; index < 30; index++) shell.write(`Earlier message ${index}\n`);
  tui.renderNow(true);
  terminal.writes.length = 0;
  shell.write("The response was invalid. No work was applied.\n");
  shell.stop();
  expect(visible(terminal)).toContain("The response was invalid. No work was applied.");
});

it("renders Tesota Shell as one persistent terminal surface", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const now = vi.fn(() => 1_000);
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui, now });

  shell.start();
  shell.write("The repository is bounded.\n");
  shell.report({ phase: "discovering", operation: "repository_discovery" });
  now.mockReturnValue(3_000);
  shell.refreshElapsed();
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Inspecting the committed repository · 2s");
  const answer = shell.ask("> ");
  terminal.send("Explain the shell");
  terminal.send("\r");

  await expect(answer).resolves.toBe("Explain the shell");
  tui.renderNow(true);
  const screen = visible(terminal);
  expect(screen).toContain("Tesota");
  expect(screen).toContain("C:\\work\\tesota");
  expect(screen).toContain("The repository is bounded.");
  expect(screen).toContain("You");
  expect(screen).toContain("Explain the shell");
  expect(screen).toContain("Ready");
  shell.stop();
  expect(terminal.started).toBe(false);
});

it.each([
  { theme: "tesota-dark" as const, accent: "198;168;210" },
  { theme: "tesota-light" as const, accent: "109;75;120" },
  { theme: "terminal" as const, accent: null },
])("renders $theme without changing the visible work state", ({ theme, accent }) => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui, theme });
  shell.start();
  shell.report({ phase: "awaiting_approval", operation: "proposal_scope" });
  shell.write("Scope approval is required before execution.");
  tui.renderNow(true);

  const rendered = terminal.writes.join("");
  const screen = visible(terminal);
  expect(screen).toContain("Tesota");
  expect(screen).toContain("Waiting for scope approval");
  expect(screen).toContain("Scope approval is required before execution.");
  if (accent === null) expect(rendered).not.toContain("\x1b[38;2;");
  else expect(rendered).toContain(`\x1b[38;2;${accent}mTesota`);
  shell.stop();
});

it("routes Ctrl+C to the active prompt or active operation and restores the terminal", async () => {
  const terminal = new TestTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const interrupt = vi.fn();
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui, interrupt });
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
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui });
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
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui });
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
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui });
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
  expect(visible(terminal)).toContain("new");
  terminal.send("\x1bj");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Review is waiting in the first session.");
  terminal.send("n");
  terminal.send("\r");
  await expect(first).resolves.toBe("n");
  shell.stop();
});

it("offers a view-only comparison while one session keeps input focus", async () => {
  const terminal = new TestTerminal();
  terminal.columns = 190;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui });
  shell.addSession("other", "Research");
  shell.writeTo("other", "The other session found a source.");
  shell.start();
  const pending = shell.askIn("default", "> ");
  terminal.send("\x1bs");
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Research · view only");
  expect(visible(terminal)).toContain("The other session found a source.");
  expect(visible(terminal)).toContain("Session 1 · input here");
  terminal.send("reply");
  terminal.send("\r");
  await expect(pending).resolves.toBe("reply");
  shell.stop();
});

it("shows source control bytes as text in the inspector", () => {
  const terminal = new TestTerminal();
  terminal.columns = 150;
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui, theme: "terminal" });
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
  const shell = createTesotaShellTerminal({ cwd: "C:\\work\\tesota", tui });
  shell.start();
  shell.inspect({ title: "Candidate result", summary: "A result is ready", detail: "Changed src/value.ts" });
  const answer = shell.ask("Accept? [y/N] ");
  terminal.send("\x1b3"); // Alt+3: inspector
  tui.renderNow(true);
  expect(visible(terminal)).toContain("Changed src/value.ts");
  terminal.send("\x1b2"); // Alt+2: conversation
  terminal.send("n");
  terminal.send("\r");
  await expect(answer).resolves.toBe("n");
  shell.stop();
});
