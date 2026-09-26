import { basename } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Editor, HStack, ScrollView, Text, VStack, matchesKey, truncateToWidth, visibleWidth,
  type Component, type EditorTheme, type ViewportTUI } from "@earendil-works/pi-tui";
import type { AgentActivity } from "./integrations/model-session-contract.js";
import { tesotaShellProgressLabel, type TesotaShellProgress } from "./shell-progress.js";
import { backgroundText, bold, colorText, mutedText, tesotaShellTheme, type TesotaShellTheme,
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
  { name: "previous", description: "Switch to the previous session" },
  { name: "close", description: "Close this session" },
  { name: "result", description: "Show or hide the review" },
  { name: "sidebar", description: "Show or hide sessions" },
  { name: "details", description: "Expand or collapse a long notice" },
  { name: "help", description: "Show commands and shortcuts" },
  { name: "quit", description: "Close Tesota" },
] as const;

/** A second press within this time confirms a key that asks first: quitting, and closing a session that holds work. */
export const CONFIRMATION_WINDOW_MS = 5_000;

/** `Alt+1` to `Alt+9` select the session the rail numbers 1 to 9. */
const numberedSessionKeys = ["alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9"] as const;

/** The session `step` places from `current` in the rail's order, wrapping around at either end. */
export function sessionBeside(ids: readonly string[], current: string, step: 1 | -1): string {
  return ids[(ids.indexOf(current) + step + ids.length) % ids.length] ?? current;
}

/** A selected row, filled to the width: the theme's selection background, or reverse video when colors are the terminal's. */
function selectedRow(line: string, width: number, theme: TesotaShellTheme): string {
  const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
  return theme.selectionBackground === null ? `\x1b[7m${padded}\x1b[27m` : backgroundText(padded, theme.selectionBackground);
}

/** A compact command picker above the prompt, with a full-width selected row. */
class CommandMenu implements Component {
  readonly #theme: TesotaShellTheme;
  #query = "";
  #enabled = false;
  #dismissed = false;
  #selected = 0;
  constructor(theme: TesotaShellTheme) { this.#theme = theme; }
  get matches(): readonly (typeof shellCommands)[number][] {
    return shellCommands.filter((command) => command.name.startsWith(this.#query.slice(1)));
  }
  get visible(): boolean {
    return this.#enabled && !this.#dismissed && /^\/[a-z]*$/u.test(this.#query) && this.matches.length > 0;
  }
  get selected(): (typeof shellCommands)[number] | undefined { return this.visible ? this.matches[this.#selected] : undefined; }
  update(query: string, enabled: boolean): void {
    if (query !== this.#query) { this.#query = query; this.#selected = 0; this.#dismissed = false; }
    this.#enabled = enabled;
  }
  move(offset: number): void {
    const count = this.matches.length;
    if (count > 0) this.#selected = (this.#selected + offset + count) % count;
  }
  dismiss(): void { this.#dismissed = true; }
  invalidate(): void {}
  render(width: number): string[] {
    if (!this.visible || width < 8) return [];
    const matches = this.matches;
    const maxRows = 5;
    const start = Math.max(0, Math.min(this.#selected - 2, matches.length - maxRows));
    const rows = matches.slice(start, start + maxRows).map((command, offset) => {
      const selected = start + offset === this.#selected;
      const name = `${selected ? "›" : " "} /${command.name}`.padEnd(18);
      const line = truncateToWidth(`${name}${command.description}`, width);
      return selected ? selectedRow(bold(line), width, this.#theme) : mutedText(line, this.#theme);
    });
    if (matches.length > maxRows) rows.push(mutedText(`  ↑↓ ${this.#selected + 1}/${matches.length}`, this.#theme));
    return rows;
  }
}

function ignoreInterrupt(): void {}

/** A single row that is cut to the width instead of wrapping, so chrome never pushes the conversation. */
class Line implements Component {
  #text = "";
  setText(text: string): void { this.#text = text; }
  invalidate(): void {}
  render(width: number): string[] { return [truncateToWidth(` ${this.#text}`, width)]; }
}

/** One repository's sessions, with each session's current need visible at a glance. */
/** One line of the session rail; the selected session's lines are highlighted across the rail's width. */
interface RailRow {
  readonly text: string;
  readonly selected?: boolean;
}

class SessionRail implements Component {
  readonly #theme: TesotaShellTheme;
  #rows: readonly RailRow[] = [];
  constructor(theme: TesotaShellTheme) { this.#theme = theme; }
  setRows(rows: readonly RailRow[]): void { this.#rows = rows; }
  invalidate(): void {}
  render(width: number): string[] {
    return this.#rows.map((row) => {
      const line = truncateToWidth(` ${row.text}`, width);
      return row.selected === true ? selectedRow(line, width, this.#theme) : line;
    });
  }
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
  return progress?.phase === "working" || progress?.phase === "checking" || progress?.phase === "preparing" ||
    progress?.phase === "reviewing";
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
  private readonly sidebar: SessionRail;
  private readonly sidebarScroll: ScrollView;
  private readonly secondaryTitle = new Line();
  private readonly status = new Line();
  private readonly footer = new Line();
  private readonly result = new Text("", 1, 0);
  private readonly commandMenu: CommandMenu;
  private readonly editor: Editor;
  private timer: ReturnType<typeof setInterval> | undefined;
  private removeInputListener: (() => void) | undefined;
  private started = false;
  /** The quit key pressed once, and when; a second press of it within the confirmation window quits. */
  private quitArmed: Readonly<{ key: "Ctrl+C" | "Ctrl+D"; at: number }> | undefined;

  constructor(options: TesotaShellTerminalOptions) {
    this.tui = options.tui;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.interrupt = () => { (options.interrupt ?? ignoreInterrupt)(this.selectedId); };
    this.theme = tesotaShellTheme(options.theme);
    this.sidebar = new SessionRail(this.theme);
    this.sidebarScroll = new ScrollView(this.sidebar, { scrollbar: "auto" });
    // Pi's code highlighter reads Pi's global theme; match its light or dark variant.
    initTheme(this.theme.name === "tesota-light" ? "light" : "dark");
    this.commandMenu = new CommandMenu(this.theme);
    this.editor = new PromptEditor(this.tui, this.theme);
    this.editor.disableSubmit = true;
    this.editor.onChange = (value) => { this.updateCommandMenu(value); };
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

  private updateCommandMenu(value: string): void {
    const session = this.selected();
    this.commandMenu.update(value, session.pending !== undefined && session.prompt === "> ");
    this.tui.requestRender();
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
      { component: new VStack([this.status, this.commandMenu, this.editor, this.footer]),
        basis: "auto", shrink: 1, minSize: 3 },
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

  /** A session's state in the rail: a need of the operator's in the warning color, work in the accent. */
  private attentionText(attention: string): string {
    if (attention === "needs you" || attention === "unresolved") return colorText(attention, this.theme.warning);
    if (attention === "working" || attention === "preparing") return colorText(attention, this.theme.accent);
    return mutedText(attention || "idle", this.theme);
  }

  private updateSidebar(): void {
    const rows: RailRow[] = [{ text: bold(colorText(safeTerminalText(basename(this.options.cwd)), this.theme.accent)) },
      { text: "" }];
    for (const [index, session] of [...this.sessions.values()].entries()) {
      const attention = this.attention(session);
      const selected = session.id === this.selectedId;
      const title = safeTerminalText(session.title);
      // Numbered as Alt+1 to Alt+9 select them; later sessions are reached with Alt+J and Alt+K.
      const number = index < numberedSessionKeys.length ? String(index + 1).padStart(2) : "  ";
      rows.push({ selected, text: `${mutedText(number, this.theme)} ${selected ? bold(title) : mutedText(title, this.theme)}` });
      rows.push({ selected, text: `   ${this.attentionText(attention)}` });
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
    if (matchesKey(data, "ctrl+c")) { this.stopOrQuit("Ctrl+C"); return { consume: true }; }
    const menuInput = this.handleCommandMenuKey(data);
    if (menuInput !== undefined) return menuInput;
    if (matchesKey(data, "escape") && this.stopWork()) return { consume: true };
    if (matchesKey(data, "ctrl+d") && this.editor.getText().length === 0 && this.stopOrQuit("Ctrl+D")) return { consume: true };
    if (matchesKey(data, "ctrl+n")) { this.options.onNewSession?.(); return { consume: true }; }
    if (matchesKey(data, "ctrl+w")) { this.options.onCloseSession?.(this.selectedId); return { consume: true }; }
    if (this.handleSessionKey(data)) return { consume: true };
    if (matchesKey(data, "alt+r")) { this.showResult = !this.showResult; this.compose(); return { consume: true }; }
    if (matchesKey(data, "alt+b")) { this.sidebarVisible = !this.sidebarVisible; this.compose(); return { consume: true }; }
    if (matchesKey(data, "alt+d")) { this.toggleLatestNotice(); return { consume: true }; }
    if (matchesKey(data, "alt+,") || matchesKey(data, "alt+.")) {
      this.moveInspection(matchesKey(data, "alt+,") ? -1 : 1);
      return { consume: true };
    }
    if (matchesKey(data, "alt+s")) { this.split = !this.split; this.compose(); return { consume: true }; }
    return undefined;
  }

  /**
   * `Esc` and `Ctrl+C` stop the selected session's work: they cancel the
   * question it is waiting on, or interrupt what is running. False when it is
   * idle at its request prompt, or has ended, so there is nothing to stop.
   */
  private stopWork(): boolean {
    const session = this.selected();
    if (session.ended || session.blocked || session.pending !== undefined && session.prompt === "> ") return false;
    if (session.pending === undefined) this.interrupt();
    else this.cancelPrompt(session);
    return true;
  }

  /**
   * As in Claude Code, Pi and Gemini CLI: `Ctrl+C` stops work first; with
   * nothing to stop it clears the input, and `Ctrl+D` works on an empty one.
   * Either then quits when pressed again within the confirmation window. The
   * session itself never ends this way. False when there was nothing to do.
   */
  private stopOrQuit(key: "Ctrl+C" | "Ctrl+D"): boolean {
    if (key === "Ctrl+C" && this.stopWork()) return true;
    if (key === "Ctrl+D" && this.selected().pending !== undefined && this.selected().prompt !== "> ") return false;
    this.editor.setText("");
    const now = this.now();
    if (this.quitArmed?.key === key && now - this.quitArmed.at <= CONFIRMATION_WINDOW_MS) {
      this.quitArmed = undefined;
      this.options.onQuit?.();
      return true;
    }
    this.quitArmed = { key, at: now };
    this.refreshElapsed();
    return true;
  }

  /** Next, previous or numbered session; true when `data` was one of those keys, even with no session at that number. */
  private handleSessionKey(data: string): boolean {
    const ids = [...this.sessions.keys()];
    if (matchesKey(data, "ctrl+tab") || matchesKey(data, "alt+j") || matchesKey(data, "alt+k")) {
      this.selectSession(sessionBeside(ids, this.selectedId, matchesKey(data, "alt+k") ? -1 : 1));
      return true;
    }
    const number = numberedSessionKeys.findIndex((key) => matchesKey(data, key));
    if (number < 0) return false;
    const id = ids[number];
    if (id !== undefined) this.selectSession(id);
    return true;
  }

  private handleCommandMenuKey(data: string): { consume: true } | undefined {
    if (this.commandMenu.visible) {
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        this.commandMenu.move(matchesKey(data, "up") ? -1 : 1);
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "escape")) {
        this.commandMenu.dismiss();
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
        const command = this.commandMenu.selected;
        if (command !== undefined) {
          const value = `/${command.name}`;
          if (matchesKey(data, "enter")) this.submit(value);
          else { this.editor.setText(value); this.commandMenu.dismiss(); this.tui.requestRender(); }
          return { consume: true };
        }
      }
    }
    return undefined;
  }

  private toggleLatestNotice(): void {
    if (this.selected().transcript.toggleNotice()) this.tui.requestRender();
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
    if (id === this.selectedId) this.selectSession(sessionBeside([...this.sessions.keys()], id, 1));
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
      this.updateCommandMenu(this.editor.getText());
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
    const quit = this.quitArmed;
    if (quit !== undefined && this.now() - quit.at <= CONFIRMATION_WINDOW_MS) {
      const working = [...this.sessions.values()].some((entry) => busy(entry.progress?.value));
      text = working ? colorText(`Press ${quit.key} again to quit. Running work stops; its changes stay in the workspace.`,
        this.theme.warning) : mutedText(`Press ${quit.key} again to quit. Sessions are restored next time.`, this.theme);
    } else if (session.blocked) text = colorText("Unresolved effects. Inspect the workspace before new work.", this.theme.warning);
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
    this.commandMenu.update("", false);
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
      case "next": case "previous":
        this.selectSession(sessionBeside([...this.sessions.keys()], this.selectedId, command === "next" ? 1 : -1));
        break;
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
        this.writeTo(session.id, "Commands: /new /next /previous /close /result /sidebar /details [number] /help /quit\n" +
          "Stop and quit: Esc or Ctrl+C stops work · Ctrl+C or Ctrl+D twice quits\n" +
          "Sessions: Ctrl+N new · Alt+J next · Alt+K previous · Alt+1…9 by number · Ctrl+W close\n" +
          "View: Alt+R result · Alt+B sidebar · Alt+D details · Alt+S split");
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
