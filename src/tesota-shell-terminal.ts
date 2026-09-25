import { basename } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Editor, HStack, ScrollView, Text, VStack, matchesKey, truncateToWidth,
  type AutocompleteProvider, type Component, type EditorTheme, type ViewportTUI } from "@earendil-works/pi-tui";
import type { AgentActivity } from "./integrations/pi-coding-session.js";
import { tesotaShellProgressLabel, type TesotaShellProgress } from "./shell-progress.js";
import { bold, colorText, mutedText, tesotaShellTheme, type TesotaShellTheme,
  type TesotaShellThemeName } from "./tesota-shell-theme.js";
import { safeTerminalText, Transcript, type NoticeTone, type TranscriptEntry } from "./tesota-shell-transcript.js";

export interface TesotaShellTerminalOptions {
  readonly cwd: string;
  readonly tui: ViewportTUI;
  readonly now?: () => number;
  readonly interrupt?: (sessionId: string) => void;
  readonly theme?: TesotaShellThemeName;
  readonly onNewSession?: () => void;
  readonly onCloseSession?: (sessionId: string) => void;
  readonly onQuit?: () => void;
  readonly onEntry?: (sessionId: string, entry: TranscriptEntry) => void;
  readonly onInspection?: (sessionId: string, inspection: ShellInspection) => void;
  readonly onSessionChange?: (sessionId: string) => void;
  readonly initialSession?: { readonly id: string; readonly title: string;
    readonly entries: readonly TranscriptEntry[];
    readonly inspections?: readonly ShellInspection[] };
}

export interface TesotaShellTerminal {
  start(): void;
  stop(): void;
  write(text: string, tone?: NoticeTone): void;
  ask(prompt: string): Promise<string>;
  report(progress: TesotaShellProgress): void;
  refreshElapsed(): void;
  inspect(inspection: ShellInspection): void;
  addSession(id: string, title: string, entries?: readonly TranscriptEntry[],
    inspections?: readonly ShellInspection[]): void;
  selectSession(id: string): void;
  /** Add a Tesota notice to a session: muted by default, colored for a warning or success. */
  writeTo(id: string, text: string, tone?: NoticeTone): void;
  askIn(id: string, prompt: string): Promise<string>;
  reportFor(id: string, progress: TesotaShellProgress): void;
  /** Clear a session's progress only while it is still in this phase, so newer progress is kept. */
  clearProgressFor(id: string, phase: TesotaShellProgress["phase"]): void;
  inspectFor(id: string, inspection: ShellInspection): void;
  /** Show the agent's replies and tool calls in a session as they happen. */
  showActivity(id: string, activity: AgentActivity): void;
  /** Name how sessions run, such as autonomous in a sandbox, in the footer. */
  setMode(label: string): void;
  blockSession(id: string): void;
  endSession(id: string): void;
  /** Remove a session from the workspace; its pending prompt fails with a closed error. */
  removeSession(id: string): void;
}

/** A review result: its short summary goes into the conversation, its detail into the result panel. */
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
  readonly transcript: Transcript;
  readonly scroll: ScrollView;
  readonly inspections: ShellInspection[];
  readonly restoredInspectionCount: number;
  selectedInspection: number;
  draft: string;
  pending: PendingPrompt | undefined;
  prompt: string;
  progress: { readonly value: TesotaShellProgress; readonly startedAt: number } | undefined;
  unread: boolean;
  blocked: boolean;
  ended: boolean;
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const spinnerMs = 120;
/** Below this width the result panel replaces the conversation instead of sitting beside it. */
const resultBesideWidth = 120;
const comparisonWidth = 160;
const sidebarWidth = 25;
const sidebarMinWidth = 88;
const shellCommands = [
  { name: "new", description: "Start a session" },
  { name: "next", description: "Switch to the next session" },
  { name: "close", description: "Close this session" },
  { name: "result", description: "Show or hide the review" },
  { name: "sidebar", description: "Show or hide sessions" },
  { name: "details", description: "Expand or collapse a long notice" },
  { name: "help", description: "Show commands and shortcuts" },
  { name: "quit", description: "Close Tesota" },
] as const;

const commandAutocomplete: AutocompleteProvider = {
  triggerCharacters: ["/"],
  async getSuggestions(lines, cursorLine, cursorCol) {
    const prefix = lines[cursorLine]?.slice(0, cursorCol) ?? "";
    if (cursorLine !== 0 || !prefix.startsWith("/") || prefix.includes(" ")) return null;
    const items = shellCommands.filter((command) => command.name.startsWith(prefix.slice(1)))
      .map((command) => ({ value: `/${command.name}`, label: command.name, description: command.description }));
    return items.length > 0 ? { items, prefix } : null;
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const current = lines[cursorLine] ?? "";
    const from = current.startsWith("/") ? 0 : cursorCol - prefix.length;
    const typed = current.slice(from, cursorCol);
    const matching = shellCommands.find((command) => `/${command.name}` === typed) ??
      shellCommands.find((command) => `/${command.name}`.startsWith(typed) && item.value === `/${command.name}`) ??
      shellCommands.find((command) => `/${command.name}`.startsWith(typed));
    const value = matching === undefined ? item.value : `/${matching.name}`;
    const next = current.slice(0, from) + value + current.slice(cursorCol);
    return { lines: lines.map((line, index) => index === cursorLine ? next : line),
      cursorLine, cursorCol: from + value.length };
  },
};

function ignoreInterrupt(): void {}

/** A single row that is cut to the width instead of wrapping, so chrome never pushes the conversation. */
class Line implements Component {
  #text = "";
  setText(text: string): void { this.#text = text; }
  invalidate(): void {}
  render(width: number): string[] { return [truncateToWidth(` ${this.#text}`, width)]; }
}

/** One repository's sessions, with each session's current need visible at a glance. */
class SessionRail implements Component {
  #rows: string[] = [];
  setRows(rows: string[]): void { this.#rows = rows; }
  invalidate(): void {}
  render(width: number): string[] { return this.#rows.map((row) => truncateToWidth(` ${row}`, width)); }
}

/** Keep Pi's editing behavior and cursor handling while removing its visible frame. */
class PromptEditor extends Editor {
  readonly #accent: string | null;
  constructor(tui: ViewportTUI, theme: TesotaShellTheme) {
    super(tui, editorTheme(theme), { paddingX: 1 });
    this.#accent = theme.accent;
  }
  protected override renderTopBorder(width: number): string { return " ".repeat(width); }
  protected override renderBottomBorder(width: number): string { return " ".repeat(width); }
  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines[1] !== undefined) lines[1] = colorText("›", this.#accent) + lines[1].slice(1);
    return lines;
  }
}

function editorTheme(theme: TesotaShellTheme): EditorTheme {
  const accent = (text: string): string => colorText(text, theme.accent);
  const muted = (text: string): string => mutedText(text, theme);
  return { borderColor: accent,
    selectList: { selectedPrefix: accent, selectedText: bold, description: muted, scrollInfo: muted, noMatch: muted } };
}

function busy(progress: TesotaShellProgress | undefined): boolean {
  return progress?.phase === "working" || progress?.phase === "checking" || progress?.phase === "preparing";
}

/** Color a unified diff and check output for the result panel. */
function resultDetail(detail: string, theme: TesotaShellTheme): string {
  return safeTerminalText(detail).split("\n").map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return bold(line);
    if (line.startsWith("+")) return colorText(line, theme.success);
    if (line.startsWith("-")) return colorText(line, theme.error);
    if (line.startsWith("@@")) return colorText(line, theme.accent);
    return line;
  }).join("\n");
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
  private showResult = false;
  private split = false;
  private sidebarVisible = true;
  private mode = "";
  private frame = 0;
  private readonly sidebar = new SessionRail();
  private readonly sidebarScroll = new ScrollView(this.sidebar, { scrollbar: "auto" });
  private readonly secondaryTitle = new Line();
  private readonly status = new Line();
  private readonly footer = new Line();
  private readonly result = new Text("", 1, 0);
  private readonly editor: Editor;
  private timer: ReturnType<typeof setInterval> | undefined;
  private removeInputListener: (() => void) | undefined;
  private started = false;

  constructor(options: TesotaShellTerminalOptions) {
    this.tui = options.tui;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.interrupt = () => { (options.interrupt ?? ignoreInterrupt)(this.selectedId); };
    this.theme = tesotaShellTheme(options.theme);
    // Pi's code highlighter reads Pi's global theme; match its light or dark variant.
    initTheme(this.theme.name === "tesota-light" ? "light" : "dark");
    this.editor = new PromptEditor(this.tui, this.theme);
    this.editor.setAutocompleteProvider(commandAutocomplete);
    this.editor.disableSubmit = true;
    this.editor.onSubmit = (answer) => { this.submit(answer); };
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

  private find(id: string): SessionView {
    const session = this.sessions.get(id);
    if (session === undefined) throw new Error("Tesota session unavailable");
    return session;
  }

  private compose(): void {
    const selected = this.selected();
    this.updateSidebar();
    this.updateResult(selected);
    this.updateStatus();
    const secondary = this.comparisonId === undefined ?
      [...this.sessions.values()].find((session) => session.id !== selected.id) :
      this.sessions.get(this.comparisonId);
    this.secondaryTitle.setText(secondary === undefined ? "" :
      mutedText(`${safeTerminalText(secondary.title)} · view only`, this.theme));
    const comparison = new VStack([
      { component: this.secondaryTitle, basis: "auto", shrink: 0 },
      { component: secondary?.scroll ?? new Text("", 0, 0), basis: 0, grow: 1, minSize: 1 },
    ], { gap: 1 });
    const reading = new HStack([
      { component: selected.scroll, basis: 0, grow: 1, minSize: 30,
        visible: (viewport) => !this.showResult || viewport.width >= resultBesideWidth },
      { component: comparison, basis: 48, shrink: 1, minSize: 30,
        visible: (viewport) => this.split && secondary !== undefined && viewport.width >= comparisonWidth },
      { component: new ScrollView(this.result, { scrollbar: "auto" }), basis: 0, grow: 1, minSize: 30,
        visible: () => this.showResult },
    ], { gap: 2 });
    const content = new VStack([
      { component: reading, basis: 0, grow: 1, minSize: 1 },
      { component: new VStack([this.status, this.editor, this.footer]), basis: "auto", shrink: 1, minSize: 3 },
    ], { gap: 1 });
    this.tui.setLayoutRoot(new HStack([
      { component: this.sidebarScroll, basis: sidebarWidth, shrink: 0,
        visible: (viewport) => this.sidebarVisible && viewport.width >= sidebarMinWidth },
      { component: content, basis: 0, grow: 1, minSize: 30 },
    ], { gap: 1 }));
    this.tui.requestRender();
  }

  private attention(session: SessionView): string {
    if (session.blocked) return "unresolved";
    if (session.ended) return "ended";
    if (session.pending !== undefined && session.prompt !== "> ") return "needs you";
    if (session.progress?.value.phase === "preparing") return "preparing";
    if (busy(session.progress?.value)) return "working";
    return session.unread ? "new" : "";
  }

  private updateSidebar(): void {
    const rows = [bold(colorText(safeTerminalText(basename(this.options.cwd)), this.theme.accent)), ""];
    for (const session of this.sessions.values()) {
      const attention = this.attention(session);
      const selected = session.id === this.selectedId;
      const color = attention === "needs you" || attention === "unresolved" ? this.theme.warning :
        attention === "working" || attention === "preparing" || selected ? this.theme.accent : this.theme.muted;
      const dot = colorText("●", color);
      const title = safeTerminalText(session.title);
      rows.push(`  ${dot} ` +
        `${selected ? bold(title) : mutedText(title, this.theme)}`);
      rows.push(mutedText(`    ${attention || "idle"}`, this.theme));
    }
    this.sidebar.setRows(rows);
    this.sidebarScroll.updateLayout(rows.length, this.tui.terminal.rows, () => this.tui.requestRender());
    const mode = this.mode.startsWith("autonomous") ? "autonomous" :
      this.mode.startsWith("supervised") ? "supervised" : this.mode;
    this.footer.setText(mutedText([mode, safeTerminalText(basename(this.options.cwd)),
      safeTerminalText(this.selected().title)].filter(Boolean).join(" · "), this.theme));
  }

  private updateResult(session: SessionView): void {
    const inspection = session.inspections[session.selectedInspection];
    if (inspection === undefined) {
      this.result.setText(mutedText("No result yet. A review's full diff and check output appear here.", this.theme));
      return;
    }
    const note = session.selectedInspection < session.restoredInspectionCount ?
      "Recorded from an earlier run. Recheck before relying on it.\n" :
      session.selectedInspection < session.inspections.length - 1 ?
        "An earlier result. A pending decision applies to the latest one.\n" : "";
    const position = session.inspections.length > 1 ?
      mutedText(` ${session.selectedInspection + 1} of ${session.inspections.length} · Alt+, Alt+.`, this.theme) : "";
    this.result.setText(`${bold(colorText(safeTerminalText(inspection.title), this.theme.accent))}${position}\n` +
      `${mutedText(note, this.theme)}\n${resultDetail(inspection.detail, this.theme)}`);
  }

  addSession(id: string, title: string, entries: readonly TranscriptEntry[] = [],
    inspections: readonly ShellInspection[] = []): void {
    if (this.sessions.has(id)) throw new Error("Tesota session already exists");
    const transcript = new Transcript(this.theme);
    for (const entry of entries) transcript.add(entry);
    this.sessions.set(id, { id, title, transcript,
      scroll: new ScrollView(transcript.container, { follow: "end", primary: true, scrollbar: "auto" }),
      inspections: [...inspections], restoredInspectionCount: inspections.length,
      selectedInspection: inspections.length - 1,
      draft: "", pending: undefined, progress: undefined,
      prompt: "> ", unread: false, blocked: false, ended: false });
    if (this.started) this.compose();
  }

  selectSession(id: string): void {
    if (!this.sessions.has(id)) throw new Error("Tesota session unavailable");
    if (id !== this.selectedId) this.comparisonId = this.selectedId;
    this.selected().draft = this.editor.getText();
    this.selectedId = id;
    const session = this.selected();
    session.unread = false;
    this.editor.setText(session.draft);
    this.editor.disableSubmit = session.pending === undefined;
    this.compose();
    const row = 2 + [...this.sessions.keys()].indexOf(id) * 2;
    const top = this.sidebarScroll.scrollTop;
    const height = this.sidebarScroll.viewportHeight;
    if (row < top) this.sidebarScroll.scrollTo(row);
    else if (height > 0 && row + 1 >= top + height) this.sidebarScroll.scrollTo(row - height + 2);
    if (session.pending !== undefined) this.tui.setFocus(this.editor);
    this.options.onSessionChange?.(id);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.removeInputListener = this.tui.addInputListener((data) => this.handleKey(data));
    this.tui.terminal.setTitle("Tesota");
    this.compose();
    this.tui.start();
    let ticks = 0;
    this.timer = setInterval(() => {
      ticks += 1;
      const animate = busy(this.selected().progress?.value);
      if (animate) this.frame = (this.frame + 1) % spinnerFrames.length;
      if (animate || ticks % Math.round(1_000 / spinnerMs) === 0) this.refreshElapsed();
    }, spinnerMs);
    this.timer.unref();
  }

  private handleKey(data: string): { consume: true } | undefined {
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
    if (matchesKey(data, "alt+r")) { this.showResult = !this.showResult; this.compose(); return { consume: true }; }
    if (matchesKey(data, "alt+b")) { this.sidebarVisible = !this.sidebarVisible; this.compose(); return { consume: true }; }
    if (matchesKey(data, "alt+d")) {
      if (this.selected().transcript.toggleNotice()) this.tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "alt+,") || matchesKey(data, "alt+.")) {
      this.moveInspection(matchesKey(data, "alt+,") ? -1 : 1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+s")) { this.split = !this.split; this.compose(); return { consume: true }; }
    return undefined;
  }

  private moveInspection(offset: number): void {
    const session = this.selected();
    session.selectedInspection = Math.max(0, Math.min(session.inspections.length - 1,
      session.selectedInspection + offset));
    this.showResult = true;
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
    const lastMessage = this.selected().transcript.lastMessage;
    if (lastMessage.length > 0) {
      const lines = new Text(lastMessage, 0, 0).render(this.tui.terminal.columns);
      this.tui.terminal.write(lines.join("\r\n") + "\r\n");
    }
  }

  private record(session: SessionView, entry: TranscriptEntry, persist: boolean): void {
    session.transcript.add(entry);
    if (persist) this.options.onEntry?.(session.id, entry);
    if (session.id !== this.selectedId) session.unread = true;
    this.updateSidebar();
    this.tui.requestRender();
  }

  write(text: string, tone: NoticeTone = "info"): void { this.writeTo(this.selectedId, text, tone); }
  writeTo(id: string, text: string, tone: NoticeTone = "info"): void {
    const content = text.trim();
    if (content.length > 0) this.record(this.find(id), { kind: "notice", text: content, tone }, true);
  }

  showActivity(id: string, activity: AgentActivity): void {
    const session = this.find(id);
    const entry = session.transcript.activity(activity);
    if (entry !== undefined) this.options.onEntry?.(id, entry);
    const current = session.progress;
    if (activity.type === "tool_started") {
      session.progress = { value: { phase: "working", activity: `${activity.tool === "bash" ? "Running" : "Using"} ` +
        (activity.subject || activity.tool) }, startedAt: current?.startedAt ?? this.now() };
    } else if (activity.type === "tool_finished" && current?.value.phase === "working") {
      session.progress = { value: { phase: "working" }, startedAt: current.startedAt };
    }
    if (session.id !== this.selectedId) session.unread = true;
    this.updateSidebar();
    this.refreshElapsed();
  }

  setMode(label: string): void {
    this.mode = label;
    this.updateSidebar();
    this.tui.requestRender();
  }

  inspect(inspection: ShellInspection): void { this.inspectFor(this.selectedId, inspection); }
  inspectFor(id: string, inspection: ShellInspection): void {
    const session = this.find(id);
    session.inspections.push(inspection);
    session.selectedInspection = session.inspections.length - 1;
    this.options.onInspection?.(id, inspection);
    this.record(session, { kind: "review", title: inspection.title, text: inspection.summary }, true);
    if (id === this.selectedId) {
      // Beside the conversation there is room to show the diff at once; narrower, it waits for Alt+R.
      const available = this.tui.terminal.columns -
        (this.sidebarVisible && this.tui.terminal.columns >= sidebarMinWidth ? sidebarWidth + 1 : 0);
      if (available >= resultBesideWidth) this.showResult = true;
      this.compose();
    }
  }

  blockSession(id: string): void {
    this.find(id).blocked = true;
    this.updateSidebar();
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
    if (this.started) this.compose();
  }

  endSession(id: string): void {
    const session = this.find(id);
    session.ended = true;
    session.progress = undefined;
    session.transcript.settle();
    if (id === this.selectedId) this.editor.disableSubmit = true;
    this.updateSidebar();
    this.refreshElapsed();
  }

  ask(prompt: string): Promise<string> { return this.askIn(this.selectedId, prompt); }
  askIn(id: string, prompt: string): Promise<string> {
    const session = this.sessions.get(id);
    if (session === undefined) return Promise.reject(new Error("Tesota session unavailable"));
    if (session.blocked) return Promise.reject(new Error("Tesota session has unresolved effects"));
    if (session.ended) return Promise.reject(new Error("Tesota session has ended"));
    if (session.pending !== undefined) return Promise.reject(new Error("Tesota Shell prompt already active"));
    if (prompt === "> ") {
      session.transcript.settle();
      // The first prompt may appear while the environment is still preparing; that progress stays visible.
      if (session.progress?.value.phase !== "preparing") session.progress = undefined;
    }
    session.prompt = prompt;
    const answer = new Promise<string>((resolve, reject) => { session.pending = { resolve, reject }; });
    if (id === this.selectedId) {
      this.editor.disableSubmit = false;
      this.tui.setFocus(this.editor);
    }
    this.updateSidebar();
    this.refreshElapsed();
    return answer;
  }

  report(progress: TesotaShellProgress): void { this.reportFor(this.selectedId, progress); }
  reportFor(id: string, progress: TesotaShellProgress): void {
    this.find(id).progress = { value: progress, startedAt: this.now() };
    this.updateSidebar();
    this.refreshElapsed();
  }

  clearProgressFor(id: string, phase: TesotaShellProgress["phase"]): void {
    const session = this.sessions.get(id);
    if (session?.progress?.value.phase !== phase) return;
    session.progress = undefined;
    this.updateSidebar();
    this.refreshElapsed();
  }

  refreshElapsed(): void { this.updateStatus(); this.tui.requestRender(); }

  /** The line above the input: what the selected session is doing, or the question it is waiting on. */
  private updateStatus(): void {
    const session = this.selected();
    const progress = session.progress;
    let text: string;
    if (session.blocked) text = colorText("Unresolved effects. Inspect the workspace before new work.", this.theme.warning);
    else if (session.ended) text = mutedText("Session ended. Ctrl+N starts a new one; Ctrl+W closes this one.", this.theme);
    else if (session.pending !== undefined && session.prompt !== "> ") {
      text = bold(colorText(safeTerminalText(session.prompt.trim()), this.theme.warning));
    } else if (progress !== undefined) {
      const elapsed = Math.max(0, Math.floor((this.now() - progress.startedAt) / 1_000));
      const spinner = busy(progress.value) ? `${colorText(spinnerFrames[this.frame] ?? "", this.theme.accent)} ` : "";
      const label = safeTerminalText(tesotaShellProgressLabel(progress.value));
      text = `${spinner}${colorText(label, this.theme.accent)} ${mutedText(`· ${elapsed}s`, this.theme)}`;
    } else text = mutedText("Ready", this.theme);
    this.status.setText(text);
    this.tui.terminal.setProgress(!session.blocked && busy(progress?.value));
  }

  private submit(answer: string): void {
    const session = this.selected();
    const pending = session.pending;
    if (pending === undefined) return;
    const command = answer.trim().slice(1).split(/\s+/u)[0];
    if (session.prompt === "> " && answer.trimStart().startsWith("/") &&
      shellCommands.some((item) => item.name === command)) {
      session.draft = "";
      this.editor.setText("");
      this.runShellCommand(session, answer.trim());
      return;
    }
    session.pending = undefined;
    session.draft = "";
    this.editor.disableSubmit = true;
    if (answer.length > 0) {
      this.editor.addToHistory(answer);
      this.record(session, { kind: "user", text: answer }, true);
    }
    session.prompt = "> ";
    this.refreshElapsed();
    pending.resolve(answer);
  }

  private runShellCommand(session: SessionView, input: string): void {
    const [command, ...args] = input.slice(1).split(/\s+/u);
    switch (command) {
      case "new": this.options.onNewSession?.(); break;
      case "next": {
        const ids = [...this.sessions.keys()];
        this.selectSession(ids[(ids.indexOf(this.selectedId) + 1) % ids.length] ?? this.selectedId);
        break;
      }
      case "close": this.options.onCloseSession?.(session.id); break;
      case "result": this.showResult = !this.showResult; this.compose(); break;
      case "sidebar": this.sidebarVisible = !this.sidebarVisible; this.compose(); break;
      case "details": {
        const number = args.length === 0 ? 1 : Number(args[0]);
        if (!Number.isSafeInteger(number) || number < 1 || args.length > 1 ||
          !session.transcript.toggleNotice(number - 1)) {
          this.writeTo(session.id, "No long notice at that number. Use /details or /details 2.", "warning");
        } else this.tui.requestRender();
        break;
      }
      case "help":
        this.writeTo(session.id, "Commands: /new /next /close /result /sidebar /details [number] /help /quit\n" +
          "Keys: Ctrl+N new · Alt+J next · Ctrl+W close · Alt+R result · Alt+B sidebar · Alt+D details · Alt+S split · Ctrl+Q quit");
        break;
      case "quit": this.options.onQuit?.(); break;
      default: this.writeTo(session.id, "Unknown command. Type / for commands or /help for shortcuts.", "warning");
    }
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
    this.updateSidebar();
  }
}

export function createTesotaShellTerminal(options: TesotaShellTerminalOptions): TesotaShellTerminal {
  return new PersistentTesotaShellTerminal(options);
}
