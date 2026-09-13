import { Box, Container, Editor, ScrollView, Text, VStack, matchesKey,
  type EditorTheme, type SelectListTheme, type ViewportTUI } from "@earendil-works/pi-tui";
import { tesotaShellProgressLabel, type TesotaShellProgress } from "./shell-progress.js";

export interface TesotaShellTerminalOptions {
  readonly cwd: string;
  readonly tui: ViewportTUI;
  readonly now?: () => number;
  readonly interrupt?: () => void;
}

export interface TesotaShellTerminal {
  start(): void;
  stop(): void;
  write(text: string): void;
  ask(prompt: string): Promise<string>;
  report(progress: TesotaShellProgress): void;
  refreshElapsed(): void;
}

interface PendingPrompt {
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
}

function ignoreInterrupt(): void {}
function cyan(text: string): string { return `\x1b[36m${text}\x1b[39m`; }
function dim(text: string): string { return `\x1b[2m${text}\x1b[22m`; }
function bold(text: string): string { return `\x1b[1m${text}\x1b[22m`; }

const selectTheme: SelectListTheme = Object.freeze({
  selectedPrefix: cyan,
  selectedText: bold,
  description: dim,
  scrollInfo: dim,
  noMatch: dim,
});

const editorTheme: EditorTheme = Object.freeze({ borderColor: cyan, selectList: selectTheme });

function promptLabel(prompt: string): string {
  if (prompt === "> ") return "Message";
  if (prompt === "Answer: ") return "Clarification";
  return prompt.trim();
}

class PersistentTesotaShellTerminal implements TesotaShellTerminal {
  private readonly tui: ViewportTUI;
  private readonly now: () => number;
  private readonly interrupt: () => void;
  private readonly transcript = new Container();
  private readonly status = new Text("Ready", 1, 0);
  private readonly prompt = new Text("Message", 1, 0);
  private readonly editor: Editor;
  private pending: PendingPrompt | undefined;
  private progress: { readonly value: TesotaShellProgress; readonly startedAt: number } | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private removeInputListener: (() => void) | undefined;
  private started = false;

  constructor(options: TesotaShellTerminalOptions) {
    this.tui = options.tui;
    this.now = options.now ?? Date.now;
    this.interrupt = options.interrupt ?? ignoreInterrupt;
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.onSubmit = (answer) => { this.submit(answer); };
    const header = new Text(`${bold("Tesota")}\n${dim(options.cwd)}`, 1, 0);
    const transcript = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
    const footer = new Box(0, 0);
    footer.addChild(new VStack([this.status, this.prompt, this.editor]));
    this.tui.setLayoutRoot(new VStack([
      { component: header, basis: "auto", shrink: 0 },
      { component: transcript, basis: 0, grow: 1, minSize: 1 },
      { component: footer, basis: "auto", shrink: 1, minSize: 3 },
    ], { gap: 1 }));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.removeInputListener = this.tui.addInputListener((data) => {
      if (!matchesKey(data, "ctrl+c")) return undefined;
      if (this.pending === undefined) this.interrupt();
      else this.cancelPrompt();
      return { consume: true };
    });
    this.tui.terminal.setTitle("Tesota Shell");
    this.tui.start();
    this.timer = setInterval(() => { this.refreshElapsed(); }, 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.removeInputListener?.();
    this.removeInputListener = undefined;
    this.cancelPrompt();
    this.tui.terminal.setProgress(false);
    this.tui.stop();
  }

  write(text: string): void {
    const content = text.trimEnd();
    if (content.length === 0) return;
    this.transcript.addChild(new Text(content, 1, 0));
    this.transcript.invalidate();
    this.tui.requestRender();
  }

  ask(prompt: string): Promise<string> {
    if (this.pending !== undefined) return Promise.reject(new Error("Tesota Shell prompt already active"));
    if (prompt === "> ") {
      this.progress = undefined;
      this.status.setText("Ready");
      this.tui.terminal.setProgress(false);
    }
    this.prompt.setText(promptLabel(prompt));
    this.editor.disableSubmit = false;
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
    return new Promise<string>((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  report(progress: TesotaShellProgress): void {
    this.progress = { value: progress, startedAt: this.now() };
    this.tui.terminal.setProgress(progress.phase === "discovering" || progress.phase === "executing");
    this.refreshElapsed();
  }

  refreshElapsed(): void {
    if (this.progress === undefined) return;
    const elapsed = Math.max(0, Math.floor((this.now() - this.progress.startedAt) / 1_000));
    this.status.setText(`${tesotaShellProgressLabel(this.progress.value)} · ${elapsed}s`);
    this.tui.requestRender();
  }

  private submit(answer: string): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    this.editor.disableSubmit = true;
    if (answer.length > 0) {
      this.editor.addToHistory(answer);
      this.transcript.addChild(new Text(`${bold("You")}\n${answer}`, 1, 0));
      this.transcript.invalidate();
    }
    this.prompt.setText("Working");
    this.tui.requestRender();
    pending.resolve(answer);
  }

  private cancelPrompt(): void {
    const pending = this.pending;
    if (pending === undefined) return;
    this.pending = undefined;
    this.editor.disableSubmit = true;
    this.editor.setText("");
    pending.reject(new DOMException("cancelled", "AbortError"));
  }
}

export function createTesotaShellTerminal(options: TesotaShellTerminalOptions): TesotaShellTerminal {
  return new PersistentTesotaShellTerminal(options);
}
