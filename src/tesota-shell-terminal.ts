import { Box, Container, Editor, HStack, ScrollView, Text, VStack, matchesKey,
  type EditorTheme, type SelectListTheme, type ViewportTUI } from "@earendil-works/pi-tui";
import { tesotaShellProgressLabel, type TesotaShellProgress } from "./shell-progress.js";
import { colorText, tesotaShellTheme, type TesotaShellTheme,
  type TesotaShellThemeName } from "./tesota-shell-theme.js";

export interface TesotaShellTerminalOptions {
  readonly cwd: string;
  readonly tui: ViewportTUI;
  readonly now?: () => number;
  readonly interrupt?: (sessionId: string) => void;
  readonly theme?: TesotaShellThemeName;
  readonly onNewSession?: () => void;
  readonly onCloseSession?: (sessionId: string) => void;
  readonly onQuit?: () => void;
  readonly onEntry?: (sessionId: string, role: "user" | "tesota", text: string) => void;
  readonly onInspection?: (sessionId: string, inspection: ShellInspection) => void;
  readonly onSessionChange?: (sessionId: string) => void;
  readonly initialSession?: { readonly id: string; readonly title: string;
    readonly entries: readonly { role: "user" | "tesota"; text: string }[];
    readonly inspections?: readonly ShellInspection[] };
}

export interface TesotaShellTerminal {
  start(): void;
  stop(): void;
  write(text: string): void;
  ask(prompt: string): Promise<string>;
  report(progress: TesotaShellProgress): void;
  refreshElapsed(): void;
  inspect(inspection: ShellInspection): void;
  addSession(id: string, title: string, entries?: readonly { role: "user" | "tesota"; text: string }[],
    inspections?: readonly ShellInspection[]): void;
  selectSession(id: string): void;
  writeTo(id: string, text: string): void;
  askIn(id: string, prompt: string): Promise<string>;
  reportFor(id: string, progress: TesotaShellProgress): void;
  /** Clear a session's progress only while it is still in this phase, so newer progress is kept. */
  clearProgressFor(id: string, phase: TesotaShellProgress["phase"]): void;
  inspectFor(id: string, inspection: ShellInspection): void;
  blockSession(id: string): void;
  endSession(id: string): void;
  /** Remove a session from the workspace; its pending prompt fails with a closed error. */
  removeSession(id: string): void;
}

export interface ShellInspection {
  readonly title: string;
  readonly summary: string;
  readonly detail: string;
}

interface PendingPrompt {
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
}

interface SessionView {
  readonly id: string;
  readonly title: string;
  readonly transcript: Container;
  readonly scroll: ScrollView;
  readonly inspections: ShellInspection[];
  readonly restoredInspectionCount: number;
  selectedInspection: number;
  draft: string;
  pending: PendingPrompt | undefined;
  prompt: string;
  progress: { readonly value: TesotaShellProgress; readonly startedAt: number } | undefined;
  lastMessage: string;
  unread: boolean;
  blocked: boolean;
  ended: boolean;
}

function ignoreInterrupt(): void {}
function dim(text: string): string { return `\x1b[2m${text}\x1b[22m`; }
function bold(text: string): string { return `\x1b[1m${text}\x1b[22m`; }
function safeTerminalText(text: string): string {
  let safe = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    safe += code <= 8 || code >= 11 && code <= 31 || code >= 127 && code <= 159 ?
      `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return safe;
}

function editorTheme(theme: TesotaShellTheme): EditorTheme {
  const accent = (text: string): string => colorText(text, theme.accent);
  const muted = (text: string): string => theme.muted === null ? dim(text) : colorText(text, theme.muted);
  const selectList: SelectListTheme = {
    selectedPrefix: accent,
    selectedText: bold,
    description: muted,
    scrollInfo: muted,
    noMatch: muted,
  };
  return { borderColor: accent, selectList };
}

function progressColor(progress: TesotaShellProgress, theme: TesotaShellTheme): string | null {
  if (progress.phase === "awaiting_decision" || progress.phase === "awaiting_command") return theme.warning;
  if (progress.phase === "applying") return theme.success;
  return theme.accent;
}

function promptLabel(prompt: string): string {
  if (prompt === "> ") return "Message";
  if (prompt === "Answer: ") return "Clarification";
  return prompt.trim();
}

class PersistentTesotaShellTerminal implements TesotaShellTerminal {
  private readonly tui: ViewportTUI;
  private readonly now: () => number;
  private readonly interrupt: () => void;
  private readonly options: TesotaShellTerminalOptions;
  private readonly theme: TesotaShellTheme;
  private readonly sessions = new Map<string, SessionView>();
  private selectedId = "default";
  private comparisonId: string | undefined;
  private narrowPanel: "conversation" | "sessions" | "inspector" = "conversation";
  private split = false;
  private readonly sessionList = new Text("", 1, 0);
  private readonly selectedTitle = new Text("", 1, 0);
  private readonly secondaryTitle = new Text("", 1, 0);
  private readonly status = new Text("Ready", 1, 0);
  private readonly prompt = new Text("Message", 1, 0);
  private readonly inspector = new Text("Result\n\nNo result to inspect yet.", 1, 0);
  private readonly editor: Editor;
  private timer: ReturnType<typeof setInterval> | undefined;
  private removeInputListener: (() => void) | undefined;
  private started = false;
  private readonly header: Text;

  constructor(options: TesotaShellTerminalOptions) {
    this.tui = options.tui;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.interrupt = () => { (options.interrupt ?? ignoreInterrupt)(this.selectedId); };
    this.theme = tesotaShellTheme(options.theme);
    this.editor = new Editor(this.tui, editorTheme(this.theme), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.onSubmit = (answer) => { this.submit(answer); };
    this.header = new Text(`${bold(colorText("Tesota", this.theme.accent))}  ` +
      colorText(options.cwd, this.theme.muted), 1, 0);
    this.selectedId = options.initialSession?.id ?? "default";
    this.addSession(this.selectedId, options.initialSession?.title ?? "Session 1",
      options.initialSession?.entries ?? [], options.initialSession?.inspections ?? []);
    this.compose();
  }

  private selected(): SessionView {
    const session = this.sessions.get(this.selectedId);
    if (session === undefined) throw new Error("Selected Tesota session unavailable");
    return session;
  }

  private compose(): void {
    const selected = this.selected();
    this.selectedTitle.setText(bold(colorText(`${selected.title} · input here`, this.theme.accent)));
    const inspection = selected.inspections[selected.selectedInspection];
    this.inspector.setText(inspection === undefined ? "Result\n\nNo result to inspect yet." :
      `${bold(colorText(safeTerminalText(inspection.title), this.theme.accent))}\n` +
      (selected.selectedInspection < selected.restoredInspectionCount ?
        "Recorded view from an earlier run. Recheck evidence before relying on it.\n" :
        selected.selectedInspection < selected.inspections.length - 1 ?
        "Earlier result. Any pending decision applies to the latest result.\n" : "") +
      `\n${safeTerminalText(inspection.detail)}`);
    this.prompt.setText(bold(colorText(promptLabel(selected.prompt), this.theme.accent)));
    this.updateStatus();
    const footer = new Box(0, 0);
    footer.addChild(new VStack([this.prompt, this.editor, this.status]));
    const center = new VStack([
      { component: this.selectedTitle, basis: "auto", shrink: 0 },
      { component: selected.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: footer, basis: "auto", shrink: 1, minSize: 3 },
    ], { gap: 1 });
    const secondary = this.comparisonId === undefined ?
      [...this.sessions.values()].find((session) => session.id !== selected.id) :
      this.sessions.get(this.comparisonId);
    this.secondaryTitle.setText(secondary === undefined ? "" : `${secondary.title} · view only`);
    const secondaryView = new VStack([
      { component: this.secondaryTitle, basis: "auto", shrink: 0 },
      { component: secondary?.scroll ?? new Text("", 0, 0), basis: 0, grow: 1, minSize: 1 },
    ], { gap: 1 });
    const content = new HStack([
      { component: new ScrollView(this.sessionList, { scrollbar: "auto" }), basis: 25, shrink: 0,
        visible: (viewport) => viewport.width >= 130 || viewport.width >= 100 && this.narrowPanel !== "inspector" ||
          viewport.width < 100 && this.narrowPanel === "sessions" },
      { component: center, basis: 0, grow: 1, minSize: 20,
        visible: (viewport) => viewport.width >= 130 || this.narrowPanel === "conversation" },
      { component: secondaryView, basis: 38, shrink: 1, minSize: 25,
        visible: (viewport) => this.split && secondary !== undefined && viewport.width >= 160 },
      { component: new ScrollView(this.inspector, { scrollbar: "auto" }), basis: 38, shrink: 1, minSize: 25,
        visible: (viewport) => viewport.width >= 130 || this.narrowPanel === "inspector" },
    ], { gap: 1 });
    this.tui.setLayoutRoot(new VStack([
      { component: this.header, basis: "auto", shrink: 0 },
      { component: content, basis: 0, grow: 1, minSize: 1 },
    ], { gap: 1 }));
    this.tui.requestRender();
  }

  private updateSessionList(): void {
    const rows = [bold(colorText("Sessions", this.theme.accent))];
    for (const session of this.sessions.values()) {
      const attention = session.blocked ? " · unresolved" : session.ended ? " · ended" :
        session.pending !== undefined && session.prompt !== "> " ? " · needs you" :
        session.progress?.value.phase === "working" || session.progress?.value.phase === "checking" ?
          " · working" : session.progress?.value.phase === "preparing" ? " · preparing" : "";
      rows.push(`${session.id === this.selectedId ? ">" : " "} ${session.title}${attention}${session.unread ? " · new" : ""}`);
    }
    this.sessionList.setText(rows.join("\n"));
  }

  addSession(id: string, title: string, entries: readonly { role: "user" | "tesota"; text: string }[] = [],
    inspections: readonly ShellInspection[] = []): void {
    if (this.sessions.has(id)) throw new Error("Tesota session already exists");
    const transcript = new Container();
    const session: SessionView = { id, title, transcript,
      scroll: new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" }),
      inspections: [...inspections], restoredInspectionCount: inspections.length,
      selectedInspection: inspections.length - 1,
      draft: "", pending: undefined, progress: undefined,
      prompt: "Message", lastMessage: "", unread: false, blocked: false, ended: false };
    this.sessions.set(id, session);
    for (const entry of entries) this.append(session, entry.role, entry.text, false);
    session.unread = false;
    this.updateSessionList();
    if (this.started) this.compose();
  }

  selectSession(id: string): void {
    if (!this.sessions.has(id)) throw new Error("Tesota session unavailable");
    if (id !== this.selectedId) this.comparisonId = this.selectedId;
    this.selected().draft = this.editor.getText();
    this.selectedId = id;
    this.narrowPanel = "conversation";
    const session = this.selected();
    session.unread = false;
    this.editor.setText(session.draft);
    this.editor.disableSubmit = session.pending === undefined;
    this.updateSessionList();
    this.compose();
    if (session.pending !== undefined) this.tui.setFocus(this.editor);
    this.options.onSessionChange?.(id);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.removeInputListener = this.tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        const session = this.selected();
        if (session.pending === undefined) this.interrupt();
        else this.cancelPrompt(session);
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+n")) { this.options.onNewSession?.(); return { consume: true }; }
      if (matchesKey(data, "ctrl+w")) { this.options.onCloseSession?.(this.selectedId); return { consume: true }; }
      if (matchesKey(data, "ctrl+q")) { this.options.onQuit?.(); return { consume: true }; }
      if (matchesKey(data, "ctrl+tab") || matchesKey(data, "alt+j")) {
        const ids = [...this.sessions.keys()];
        this.selectSession(ids[(ids.indexOf(this.selectedId) + 1) % ids.length] ?? this.selectedId);
        return { consume: true };
      }
      if (matchesKey(data, "alt+1") || matchesKey(data, "alt+2") || matchesKey(data, "alt+3")) {
        this.selectNarrowPanel(data);
        return { consume: true };
      }
      if (matchesKey(data, "alt+,") || matchesKey(data, "alt+.")) {
        this.moveInspection(matchesKey(data, "alt+,") ? -1 : 1);
        return { consume: true };
      }
      if (matchesKey(data, "alt+s")) { this.split = !this.split; this.compose(); return { consume: true }; }
      return undefined;
    });
    this.tui.terminal.setTitle("Tesota Shell");
    this.tui.start();
    this.timer = setInterval(() => { this.refreshElapsed(); }, 1_000);
    this.timer.unref();
  }

  private selectNarrowPanel(data: string): void {
    this.narrowPanel = matchesKey(data, "alt+1") ? "sessions" :
      matchesKey(data, "alt+3") ? "inspector" : "conversation";
    this.compose();
    if (this.narrowPanel === "conversation" && this.selected().pending !== undefined) this.tui.setFocus(this.editor);
    else if (this.tui.terminal.columns < 130) this.tui.setFocus(null);
  }

  private moveInspection(offset: number): void {
    const session = this.selected();
    session.selectedInspection = Math.max(0, Math.min(session.inspections.length - 1,
      session.selectedInspection + offset));
    this.compose();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.removeInputListener?.();
    this.removeInputListener = undefined;
    for (const session of this.sessions.values()) this.cancelPrompt(session);
    this.tui.terminal.setProgress(false);
    this.tui.stop({ preserveScreen: true });
    const lastMessage = this.selected().lastMessage;
    if (lastMessage.length > 0) {
      const lines = new Text(lastMessage, 0, 0).render(this.tui.terminal.columns);
      this.tui.terminal.write(lines.join("\r\n") + "\r\n");
    }
  }

  private append(session: SessionView, role: "user" | "tesota", text: string, retain: boolean): void {
    const content = text.trimEnd();
    if (content.length === 0) return;
    session.lastMessage = safeTerminalText(content);
    session.transcript.addChild(new Text(role === "user" ?
      `${bold(colorText("You", this.theme.accent))}\n${safeTerminalText(content)}` :
      safeTerminalText(content), 1, 0));
    session.transcript.invalidate();
    if (session.id !== this.selectedId) session.unread = true;
    if (retain) this.options.onEntry?.(session.id, role, content);
    this.updateSessionList();
    this.tui.requestRender();
  }

  write(text: string): void { this.writeTo(this.selectedId, text); }
  writeTo(id: string, text: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Tesota session unavailable");
    this.append(session, "tesota", text, true);
  }

  inspect(inspection: ShellInspection): void { this.inspectFor(this.selectedId, inspection); }
  inspectFor(id: string, inspection: ShellInspection): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Tesota session unavailable");
    session.inspections.push(inspection);
    this.options.onInspection?.(id, inspection);
    session.selectedInspection = session.inspections.length - 1;
    this.writeTo(id, inspection.summary);
    if (id === this.selectedId) this.compose();
  }

  blockSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Tesota session unavailable");
    session.blocked = true;
    this.updateSessionList();
    this.refreshElapsed();
  }

  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    if (this.sessions.size === 1) throw new Error("The last Tesota session cannot be removed");
    if (id === this.selectedId) {
      const ids = [...this.sessions.keys()];
      this.selectSession(ids[(ids.indexOf(id) + 1) % ids.length] ?? id);
    }
    const pending = session.pending;
    session.pending = undefined;
    this.sessions.delete(id);
    if (this.comparisonId === id) this.comparisonId = undefined;
    pending?.reject(new DOMException("closed", "AbortError"));
    this.updateSessionList();
    if (this.started) this.compose();
  }

  endSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Tesota session unavailable");
    session.ended = true;
    session.progress = undefined;
    if (id === this.selectedId) this.editor.disableSubmit = true;
    this.updateSessionList();
    this.refreshElapsed();
  }

  ask(prompt: string): Promise<string> { return this.askIn(this.selectedId, prompt); }
  askIn(id: string, prompt: string): Promise<string> {
    const session = this.sessions.get(id);
    if (session === undefined) return Promise.reject(new Error("Tesota session unavailable"));
    if (session.blocked) return Promise.reject(new Error("Tesota session has unresolved effects"));
    if (session.ended) return Promise.reject(new Error("Tesota session has ended"));
    if (session.pending !== undefined) return Promise.reject(new Error("Tesota Shell prompt already active"));
    // The first prompt may appear while the environment is still preparing; that progress stays visible.
    if (prompt === "> " && session.progress?.value.phase !== "preparing") session.progress = undefined;
    session.prompt = prompt;
    const answer = new Promise<string>((resolve, reject) => { session.pending = { resolve, reject }; });
    this.updateSessionList();
    if (id === this.selectedId) {
      this.narrowPanel = "conversation";
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
      this.compose();
    }
    return answer;
  }

  report(progress: TesotaShellProgress): void { this.reportFor(this.selectedId, progress); }
  reportFor(id: string, progress: TesotaShellProgress): void {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Tesota session unavailable");
    session.progress = { value: progress, startedAt: this.now() };
    this.updateSessionList();
    this.refreshElapsed();
  }

  clearProgressFor(id: string, phase: TesotaShellProgress["phase"]): void {
    const session = this.sessions.get(id);
    if (session?.progress?.value.phase !== phase) return;
    session.progress = undefined;
    this.updateSessionList();
    this.refreshElapsed();
  }

  refreshElapsed(): void { this.updateStatus(); this.tui.requestRender(); }

  private updateStatus(): void {
    const progress = this.selected().progress;
    if (this.selected().blocked) this.status.setText(colorText("Unresolved effects · inspect evidence before new work", this.theme.warning));
    else if (this.selected().ended) this.status.setText(colorText("Session ended · Ctrl+N new · Ctrl+W close · Alt+J switch · Ctrl+Q quit", this.theme.muted));
    else if (progress === undefined) this.status.setText(colorText("Ready · Ctrl+N new · Ctrl+W close · Alt+J switch · Ctrl+Q quit", this.theme.muted));
    else {
      const elapsed = Math.max(0, Math.floor((this.now() - progress.startedAt) / 1_000));
      const label = tesotaShellProgressLabel(progress.value);
      this.status.setText(`${colorText(label, progressColor(progress.value, this.theme))} · ${elapsed}s`);
    }
    this.tui.terminal.setProgress(!this.selected().blocked && (progress?.value.phase === "working" ||
      progress?.value.phase === "checking" || progress?.value.phase === "preparing"));
  }

  private submit(answer: string): void {
    const session = this.selected();
    const pending = session.pending;
    if (pending === undefined) return;
    session.pending = undefined;
    session.draft = "";
    this.editor.disableSubmit = true;
    if (answer.length > 0) {
      this.editor.addToHistory(answer);
      this.append(session, "user", answer, true);
    }
    session.prompt = "Working";
    this.prompt.setText(colorText("Working", this.theme.muted));
    this.updateSessionList();
    this.tui.requestRender();
    pending.resolve(answer);
  }

  private cancelPrompt(session: SessionView): void {
    const pending = session.pending;
    if (pending === undefined) return;
    session.pending = undefined;
    if (session.id === this.selectedId) {
      this.editor.disableSubmit = true;
      this.editor.setText("");
    }
    pending.reject(new DOMException("cancelled", "AbortError"));
    this.updateSessionList();
  }
}

export function createTesotaShellTerminal(options: TesotaShellTerminalOptions): TesotaShellTerminal {
  return new PersistentTesotaShellTerminal(options);
}
