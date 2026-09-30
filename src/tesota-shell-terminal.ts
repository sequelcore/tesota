import { basename } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Editor, HStack, ScrollView, Text, VStack, isKeyRelease, matchesKey, truncateToWidth, wrapTextWithAnsi,
  type Component, type EditorTheme, type OverlayHandle, type ViewportTUI } from "@earendil-works/pi-tui";
import type { SessionExecution } from "./execution-providers.js";
import type { AgentActivity } from "./integrations/model-session-contract.js";
import { SHELL_SPINNER_FRAMES, tesotaShellProgressLabel, type TesotaShellProgress } from "./shell-progress.js";
import { bold, colorText, fadedText, mutedText, parseTesotaShellTheme, selectedRow, tesotaShellTheme, TESOTA_SHELL_THEME_NAMES, type TesotaShellTheme,
  type TesotaShellThemeName } from "./tesota-shell-theme.js";
import { recordRows, safeTerminalText, Transcript, type NoticeTone, type TranscriptEntry } from "./tesota-shell-transcript.js";
import { DiffView } from "./tesota-shell-diff.js";
import { ModelPicker, type ModelPickerData } from "./tesota-shell-model-picker.js";
import { ThemePicker } from "./tesota-shell-theme-picker.js";
import { ChoicePicker, type ShellChoice } from "./tesota-shell-choice-picker.js";
import { QuestionPanel, type ShellQuestion } from "./tesota-shell-question.js";
import type { Backdrop } from "./tesota-shell-tui.js";
import { ACCOUNTS_PANEL_HEIGHT, ACCOUNTS_PANEL_WIDTH, ACCOUNTS_TABS, AccountsPanel, type AccountsSource, type AccountsTab }
  from "./tesota-shell-accounts.js";
import { SessionRail, SessionSidebarHeader, SessionSidebarOverlay, sessionStateIcon, type SidebarSession } from "./tesota-shell-sidebar.js";
import { planLines, type WorkPlan } from "./work-plan.js";
import { WelcomeBanner } from "./tesota-shell-welcome.js";
import { animatedSidebarState, attentionSidebarState, newestFirstSourceIndex, otherSessionsWaiting, sidebarPresentation,
  sidebarSessionState, terminalTitleMark, type SidebarPreference, type SidebarSessionState } from "./verification/sidebar-rule.js";

export interface TesotaShellTerminalOptions {
  readonly cwd: string;
  /** The shell's TUI; one with a backdrop fades the layout beneath an open panel. */
  readonly tui: ViewportTUI & Partial<Backdrop>;
  readonly now?: () => number;
  readonly interrupt?: (sessionId: string) => void;
  /** `Tab` while a session works: send a message to its agent now; false when the agent cannot take it, and it is queued. */
  readonly onSteer?: (sessionId: string, text: string) => boolean;
  readonly theme?: TesotaShellThemeName;
  readonly onNewSession?: () => void;
  readonly onCloseSession?: (sessionId: string) => void;
  /** `/model`, with its argument when one was given. */
  readonly onModel?: (sessionId: string, argument: string | undefined) => void;
  /** The models the `/model` picker offers a session's agent; without it, `/model` alone asks the shell to list them. */
  /** The picker's choices for a prefix: `/model ` for the session's agent, `/roles ` for a role, `/roles <role> ` for its model. */
  readonly modelPicker?: (sessionId: string, prefix: string) => ModelPickerData | undefined;
  /** `/roles <role> <choice>`: the model a role uses in every session, as `tesota roles` sets it. */
  readonly onRoleModel?: (sessionId: string, args: readonly string[]) => void;
  /** `/rename <name>` names the session; `/rename` alone asks for a title from its requests (decision 036). */
  readonly onRename?: (sessionId: string, name: string | undefined) => void;
  readonly onHandoff?: (sessionId: string) => void;
  /** `/keep`, `/revert [all|agent]` and `/redo`: decide a session's turns in the operator's files at any time. */
  readonly onKeep?: (sessionId: string) => void;
  readonly onRevert?: (sessionId: string, args: readonly string[]) => void;
  readonly onRedo?: (sessionId: string) => void;
  /** `/isolate`: before its first request, a session works in an isolated workspace instead of the operator's files. */
  readonly onIsolate?: (sessionId: string) => void;
  /** `/checks [reset]`: the repository's approved checks and the hidden files they may read. */
  readonly onChecks?: (sessionId: string, args: readonly string[]) => void;
  /** `/sandbox`, with its argument when one was given (decision 030). */
  readonly onSandbox?: (sessionId: string, argument: string | undefined) => void;
  /** What the Accounts panel shows: `/accounts`, `/usage` and Alt+A (decision 051). */
  readonly accounts?: AccountsSource;
  readonly sandboxPicker?: (sessionId: string) => { title: string; entries: readonly ShellChoice[] };
  readonly onQuit?: () => void;
  readonly onEntry?: (sessionId: string, entry: TranscriptEntry) => void;
  readonly onInspection?: (sessionId: string, inspection: ShellInspection) => void;
  readonly onSessionChange?: (sessionId: string) => void;
  readonly initialSession?: { readonly id: string; readonly title: string;
    readonly entries: readonly TranscriptEntry[];
    /** Show the ephemeral opening only when this session was just created. */
    readonly fresh?: boolean;
    readonly inspections?: readonly ShellInspection[] };
}

export interface TesotaShellTerminal {
  start(): void;
  stop(): void;
  /** Whether the terminal has focus, as it reports when focus reporting is on; assumed focused until told. */
  setTerminalFocused(focused: boolean): void;
  write(text: string, tone?: NoticeTone): void;
  ask(prompt: string): Promise<string>;
  report(progress: TesotaShellProgress): void;
  refreshElapsed(): void;
  inspect(inspection: ShellInspection): void;
  addSession(id: string, title: string, entries?: readonly TranscriptEntry[],
    inspections?: readonly ShellInspection[], fresh?: boolean): void;
  selectSession(id: string): void;
  /**
   * Record a Tesota notice in a session: something that happened to its work, such as where its commands run or a
   * turn kept or reverted. It is saved with the session and ends its opening. Muted by default, colored for a warning
   * or success. What the agent must also know goes to it separately, with its next request.
   */
  writeTo(id: string, text: string, tone?: NoticeTone): void;
  /**
   * Answer the operator in a session, such as help, a listing, a usage hint or a setting confirmed. It shows like a
   * notice but is not saved, is not part of the session's work, and never reaches the agent.
   */
  replyTo(id: string, text: string, tone?: NoticeTone): void;
  askIn(id: string, prompt: string): Promise<string>;
  /**
   * Ask a question with fixed answers in a session: its answers replace the input until one is picked, and the
   * picked answer's record, if it has one, is kept in the conversation.
   */
  chooseIn<V extends string>(id: string, question: ShellQuestion<V>): Promise<V>;
  /** Whether the operator typed messages while the session worked that its next request prompt has not taken yet. */
  hasQueued(id: string): boolean;
  reportFor(id: string, progress: TesotaShellProgress): void;
  /** Clear a session's progress only while it is still in this phase, so newer progress is kept. */
  clearProgressFor(id: string, phase: TesotaShellProgress["phase"]): void;
  inspectFor(id: string, inspection: ShellInspection): void;
  /** Show the agent's replies and tool calls in a session as they happen. */
  showActivity(id: string, activity: AgentActivity): void;
  /**
   * Where a session's commands run, such as its sandbox, shown under the prompt while it is selected, in a color for
   * the place: the theme's caution color on this computer, its success color in a sandbox.
   */
  setSessionExecution(id: string, label: string, place: SessionExecution["commands"]): void;
  /** The agent's plan for a session's work (decision 033), shown above the prompt while it is selected; undefined clears it. */
  setSessionPlan(id: string, plan: WorkPlan | undefined): void;
  /** The source repository's branch, shown with repository identity; undefined when Git cannot say. */
  setBranch(branch: string | undefined): void;
  /** The model the session's agent runs, as `route:model`, shown beside the prompt while it is selected. */
  setSessionModel(id: string, model: string): void;
  setSessionTitle(id: string, title: string): void;
  blockSession(id: string): void;
  endSession(id: string): void;
  /** Remove a session from the workspace; its pending prompt fails with a closed error. */
  removeSession(id: string): void;
}

/** A review result: its short summary goes into the conversation, its detail into the result panel. */
export interface ShellInspection {
  readonly title: string;
  readonly summary: string;
  /**
   * Sections under unindented headings; nested lines are indented and may
   * start with a mark (✓ ✗ ⚠ ? ·) or, for command output, a │ gutter.
   */
  readonly detail: string;
  /** The candidate's unified diff, drawn as a diff view below `detail`; absent from results recorded before it was kept apart. */
  readonly diff?: string | undefined;
}

interface PendingPrompt {
  readonly resolve: (answer: string) => void;
  readonly reject: (error: Error) => void;
}

interface SessionView {
  readonly id: string;
  title: string;
  readonly transcript: Transcript;
  readonly welcome?: WelcomeBanner;
  readonly scroll: ScrollView;
  readonly inspections: ShellInspection[];
  readonly restoredInspectionCount: number;
  selectedInspection: number;
  draft: string;
  pending: PendingPrompt | undefined;
  prompt: string;
  /** The question with fixed answers the pending prompt asks, drawn in place of the input. */
  question: QuestionPanel | undefined;
  /** Messages typed while the session worked, which its next request prompts take in order. */
  readonly queued: string[];
  progress: { readonly value: TesotaShellProgress; readonly startedAt: number } | undefined;
  unread: boolean;
  blocked: boolean;
  ended: boolean;
  /** The model the session's agent runs, once known. */
  model?: string;
  /** Where the session's commands run, once its environment is chosen. */
  execution?: { readonly label: string; readonly place: SessionExecution["commands"] };
  /** The agent's plan for the session's current work. */
  plan?: WorkPlan;
}

const spinnerMs = 120;
/** Below this width the result panel replaces the conversation instead of sitting beside it. */
const resultBesideWidth = 120;
const comparisonWidth = 160;
const sidebarWidth = 25;
const shellCommands = [
  { name: "new", description: "Start a session" },
  { name: "next", description: "Switch to the next session" },
  { name: "previous", description: "Switch to the previous session" },
  { name: "close", description: "Close this session" },
  { name: "rename", description: "Name this session, or suggest a name" },
  { name: "model", description: "Show or switch the agent's model" },
  { name: "roles", description: "Choose each role's model" },
  { name: "handoff", description: "Start the agent's conversation afresh" },
  { name: "sandbox", description: "Show or switch where this session's commands run" },
  { name: "isolate", description: "Work in an isolated copy instead of your files; before the first request" },
  { name: "keep", description: "Keep this session's undecided turns in your files" },
  { name: "revert", description: "Undo the latest undecided turn; again steps further back" },
  { name: "redo", description: "Put the latest reverted turn back" },
  { name: "checks", description: "Show the approved checks, or choose them again with reset" },
  { name: "accounts", description: "Show accounts: usage, sign-ins and each role's account" },
  { name: "usage", description: "Show how much each account has left" },
  { name: "result", description: "Show or hide the review" },
  { name: "sidebar", description: "Show or hide sessions" },
  { name: "themes", description: "Choose the shell's theme from a list" },
  { name: "details", description: "Expand or collapse a long notice" },
  { name: "help", description: "Show commands and shortcuts" },
  { name: "quit", description: "Close Tesota" },
] as const;

/** A session whose effects need `tesota recover` asks nothing more; its waiting prompt ends with this. */
export class SessionBlockedError extends Error {
  constructor() {
    super("Tesota session has unresolved effects");
    this.name = "SessionBlockedError";
  }
}

/** A second press within this time confirms a key that asks first: quitting, and closing a session that holds work. */
export const CONFIRMATION_WINDOW_MS = 5_000;

/** `Alt+1` to `Alt+9` select the session the rail numbers 1 to 9. */
const numberedSessionKeys = ["alt+1", "alt+2", "alt+3", "alt+4", "alt+5", "alt+6", "alt+7", "alt+8", "alt+9"] as const;

/** The session `step` places from `current` in the rail's order, wrapping around at either end. */
export function sessionBeside(ids: readonly string[], current: string, step: 1 | -1): string {
  return ids[(ids.indexOf(current) + step + ids.length) % ids.length] ?? current;
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

/** Whether input names a shell command, such as `/model`, which the shell runs instead of sending it to the agent. */
function shellCommand(input: string): boolean { return /^\/[a-z]+(?:\s|$)/u.test(input.trimStart()); }

/**
 * A row cut to the width, so chrome never pushes the conversation; or, when
 * `whole`, wrapped over as many rows as it needs, for text the operator must
 * read in full, such as a command waiting for approval.
 */
class Line implements Component {
  #text = "";
  #whole = false;
  setText(text: string, whole = false): void { this.#text = text; this.#whole = whole; }
  invalidate(): void {}
  render(width: number): string[] {
    return this.#whole ? wrapTextWithAnsi(` ${this.#text}`, width) : [truncateToWidth(` ${this.#text}`, width)];
  }
}

/** Lines whose text is read at each render, for what follows the terminal's size. */
class LiveLines implements Component {
  readonly #lines: () => readonly string[];
  constructor(lines: () => readonly string[]) { this.#lines = lines; }
  invalidate(): void {}
  render(width: number): string[] { return this.#lines().map((line) => truncateToWidth(` ${line}`, width)); }
}

/** The agent's plan: progress, then its steps, the one in progress in full color and the rest dimmed. */
class PlanPanel implements Component {
  #lines: string[] = [];
  set(plan: WorkPlan | undefined, theme: TesotaShellTheme): void {
    if (plan === undefined) { this.#lines = []; return; }
    const current = plan.findIndex((step) => step.status === "in_progress");
    // The steps come from the model, so their text is made safe for the terminal.
    this.#lines = planLines(plan).map((line, index) => index === current + 1 ? safeTerminalText(line)
      : mutedText(safeTerminalText(line), theme));
  }
  get visible(): boolean { return this.#lines.length > 0; }
  invalidate(): void {}
  render(width: number): string[] { return this.#lines.map((line) => truncateToWidth(` ${line}`, width)); }
}

/**
 * While the session works: the messages queued for its next request, one row
 * each, and how what is being typed can be sent, since Enter no longer waits.
 */
class QueuePanel implements Component {
  #lines: string[] = [];
  set(queued: readonly string[], typing: boolean, theme: TesotaShellTheme): void {
    const hint = typing ? "Enter queues it for after this turn · Tab sends it to the agent now"
      : queued.length > 0 ? "Sent in order after this turn · Esc stops the work and returns them to the input" : undefined;
    this.#lines = [...queued.map((text) => `↳ ${safeTerminalText(text.replace(/\s+/gu, " "))}`),
      ...hint === undefined ? [] : [hint]].map((line) => mutedText(line, theme));
  }
  get visible(): boolean { return this.#lines.length > 0; }
  invalidate(): void {}
  render(width: number): string[] { return this.#lines.map((line) => truncateToWidth(` ${line}`, width)); }
}

/** Keep Pi's editing behavior and cursor handling while removing its visible frame. */
class PromptEditor extends Editor {
  readonly #theme: TesotaShellTheme;
  constructor(tui: ViewportTUI, theme: TesotaShellTheme) {
    super(tui, editorTheme(theme), { paddingX: 1 });
    this.#theme = theme;
  }
  // A rule above and below the input sets it apart from the conversation and the lines beneath it.
  protected override renderTopBorder(width: number): string { return mutedText("─".repeat(width), this.#theme); }
  protected override renderBottomBorder(width: number): string { return mutedText("─".repeat(width), this.#theme); }
  override render(width: number): string[] {
    const lines = super.render(width);
    if (lines[1] !== undefined) lines[1] = colorText("›", this.#theme.accent) + lines[1].slice(1);
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
  return progress !== undefined && animatedSidebarState(progress.phase);
}

/** The result panel: a heading, the record under section headings, then the candidate's diff as a diff view. */
class ResultPanel implements Component {
  readonly diff: DiffView;
  readonly #theme: TesotaShellTheme;
  #heading = "";
  #record = "";
  #cached: { width: number; lines: string[] } | undefined;
  constructor(theme: TesotaShellTheme) { this.#theme = theme; this.diff = new DiffView(theme); }
  /** Show a styled heading and a record's plain text beneath it. */
  show(heading: string, record = ""): void { this.#heading = heading; this.#record = record; this.#cached = undefined; }
  invalidate(): void { this.#cached = undefined; }
  render(width: number): string[] {
    if (this.#cached?.width !== width) {
      const inner = Math.max(1, width - 2);
      const lines = [...wrapTextWithAnsi(this.#heading, inner),
        ...this.#record.length === 0 ? [] : recordRows(this.#record, inner, this.#theme, true)].map((row) => ` ${row}`);
      this.#cached = { width, lines };
    }
    const diff = this.diff.render(width);
    return [...this.#cached.lines, ...(diff.length === 0 ? [] : ["", ...diff])];
  }
}

class PersistentTesotaShellTerminal implements TesotaShellTerminal {
  private readonly tui: ViewportTUI & Partial<Backdrop>;
  private readonly now: () => number;
  private readonly interrupt: () => void;
  private readonly options: TesotaShellTerminalOptions;
  private readonly theme: TesotaShellTheme;
  private readonly sessions = new Map<string, SessionView>();
  private selectedId = "default";
  private comparisonId: string | undefined;
  private showResult = false;
  private split = false;
  private sidebarPreference: SidebarPreference = "auto";
  /** The source repository's branch, where results are applied. */
  private branch: string | undefined;
  private frame = 0;
  /** The title last written to the terminal. */
  private windowTitle = "";
  private readonly sidebarHeader: SessionSidebarHeader;
  private readonly sidebar: SessionRail;
  private readonly sidebarScroll: ScrollView;
  private readonly secondaryTitle = new Line();
  private readonly status = new Line();
  private readonly plan = new PlanPanel();
  private readonly queue = new QueuePanel();
  /**
   * Under the prompt, as other harnesses order it: the selected session's model, joined by the repository and branch
   * while the sidebar is hidden; then where its commands run, in the color for that place.
   */
  private readonly footer = new LiveLines(() => {
    const { execution, model } = this.selected();
    const workspace = sidebarPresentation(this.sidebarPreference, this.tui.terminal.columns) !== "hidden" ? "" :
      `${safeTerminalText(basename(this.options.cwd))}${this.branch === undefined ? "" : ` · ${safeTerminalText(this.branch)}`}`;
    const identity = [model === undefined ? "" : safeTerminalText(model), workspace].filter(Boolean).join(" · ");
    const place = execution === undefined ? "" :
      colorText(execution.label, execution.place === "host" ? this.theme.warning : this.theme.success);
    return [identity === "" ? "" : mutedText(identity, this.theme), place].filter(Boolean);
  });
  /** The selected session's waiting question, in place of the input. */
  private readonly question = new VStack();
  private readonly result: ResultPanel;
  /** One scroll view for the result panel, kept across layouts so its position survives them. */
  private readonly resultScroll: ScrollView;
  private readonly commandMenu: CommandMenu;
  private readonly modelPicker: ModelPicker;
  private readonly themePicker: ThemePicker;
  private readonly choicePicker: ChoicePicker;
  private readonly accountsPanel: AccountsPanel;
  /** The Accounts panel while it is open. */
  private accountsOverlay: OverlayHandle | undefined;
  /** Which read of the panel's content is current, so a slower earlier read never overwrites a later one. */
  private accountsRead = 0;
  private readonly editor: Editor;
  private timer: ReturnType<typeof setInterval> | undefined;
  private terminalFocused = true;
  private terminalBackground: readonly [number, number, number] | undefined;
  private welcomeFrame: ReturnType<typeof setTimeout> | undefined;
  private removeInputListener: (() => void) | undefined;
  private started = false;
  /** The quit key pressed once, and when; a second press of it within the confirmation window quits. */
  private quitArmed: Readonly<{ key: "Ctrl+C" | "Ctrl+D"; at: number }> | undefined;

  constructor(options: TesotaShellTerminalOptions) {
    this.tui = options.tui;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.interrupt = () => { (options.interrupt ?? ignoreInterrupt)(this.selectedId); };
    this.theme = { ...tesotaShellTheme(options.theme) };
    this.sidebarHeader = new SessionSidebarHeader(this.theme);
    this.sidebar = new SessionRail(this.theme);
    this.result = new ResultPanel(this.theme);
    this.resultScroll = new ScrollView(this.result, { scrollbar: "auto" });
    this.sidebarScroll = new ScrollView(this.sidebar, { scrollbar: "auto" });
    // Pi's code highlighter reads Pi's global theme; match its light or dark variant.
    initTheme(this.theme.appearance === "light" ? "light" : "dark");
    this.commandMenu = new CommandMenu(this.theme);
    this.modelPicker = new ModelPicker(this.theme);
    this.themePicker = new ThemePicker(this.theme);
    this.choicePicker = new ChoicePicker(this.theme);
    this.accountsPanel = new AccountsPanel(this.theme, () => this.tui.terminal.rows, this.now);
    this.editor = new PromptEditor(this.tui, this.theme);
    this.editor.onChange = (value) => { this.updateCommandMenu(value); };
    this.editor.onSubmit = (answer) => { this.submit(answer); };
    this.selectedId = options.initialSession?.id ?? "default";
    this.addSession(this.selectedId, options.initialSession?.title ?? "Session 1",
      options.initialSession?.entries ?? [], options.initialSession?.inspections ?? [],
      options.initialSession?.fresh ?? options.initialSession === undefined);
    this.tui.showOverlay(
      new SessionSidebarOverlay(this.sidebarHeader, this.sidebar, () => this.tui.terminal.rows),
      { width: sidebarWidth, maxHeight: "100%", anchor: "top-right", nonCapturing: true,
        // Hidden under an open panel: overlays are drawn after the backdrop fades the layout, so it would stay bright.
        visible: (width) => sidebarPresentation(this.sidebarPreference, width) === "overlay" && this.accountsOverlay === undefined },
    );
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

  /** Whether a session is working: it takes input, but asks nothing, so what is typed waits for it or steers it. */
  private working(session: SessionView): boolean {
    return session.pending === undefined && !session.ended && !session.blocked;
  }

  /** Every session that has not ended or been blocked takes input: an answer at its prompt, or a message while it works. */
  private updateSubmit(session: SessionView): void {
    if (session.id === this.selectedId) this.editor.disableSubmit = session.ended || session.blocked;
  }

  private updateQueue(): void {
    const session = this.selected();
    this.queue.set(session.queued, this.working(session) && this.editor.getText().trim().length > 0, this.theme);
  }

  private updateCommandMenu(value: string): void {
    this.updateQueue();
    const session = this.selected();
    const atPrompt = session.pending !== undefined && session.prompt === "> ";
    this.commandMenu.update(value, atPrompt);
    this.modelPicker.update(value, atPrompt, (prefix) => this.options.modelPicker?.(this.selectedId, prefix));
    this.themePicker.update(value, atPrompt);
    this.choicePicker.update(value, atPrompt, (prefix) => prefix === "/sandbox "
      ? this.options.sandboxPicker?.(this.selectedId)
      : { title: "Long notices", entries: this.selected().transcript.noticePreviews.map((preview, index) => ({
        value: String(index + 1), label: String(index + 1), detail: preview,
      })) });
    this.tui.requestRender();
  }

  private compose(): void {
    const selected = this.selected();
    this.plan.set(selected.plan, this.theme);
    this.updateQueue();
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
    // On a narrow terminal the result replaces the conversation in the session's column, above the prompt.
    const resultInColumn = (): boolean => this.showResult && this.contentWidth(this.tui.terminal.columns) < resultBesideWidth;
    const session = new VStack([
      { component: selected.scroll, basis: 0, grow: 1, minSize: 1, visible: () => !resultInColumn() },
      { component: this.resultScroll, basis: 0, grow: 1, minSize: 1, visible: () => resultInColumn() },
      { component: new VStack([{ component: this.plan, basis: "auto", visible: () => this.plan.visible },
        { component: this.queue, basis: "auto", visible: () => this.queue.visible }, this.status, this.commandMenu, this.modelPicker, this.themePicker, this.choicePicker,
        { component: this.editor, basis: "auto", visible: () => this.selected().question === undefined },
        { component: this.question, basis: "auto", visible: () => this.selected().question !== undefined }, this.footer]),
        basis: "auto", shrink: 1, minSize: 3 },
    ], { gap: 1 });
    const sidebar = new VStack([
      { component: this.sidebarHeader, basis: "auto", shrink: 0 },
      { component: this.sidebarScroll, basis: 0, grow: 1, minSize: 1 },
    ], { gap: 1 });
    // pi-tui sizes an HStack's columns by rendering each whole, every frame, so no HStack may hold one inside a
    // column: a conversation nested there was composited line by line on each frame, 170 ms at 200 replies. The
    // panels beside the conversation are the root's own columns instead, as Pi keeps its transcript in no HStack.
    this.tui.setLayoutRoot(new HStack([
      { component: sidebar, basis: sidebarWidth, shrink: 0,
        visible: (viewport) => sidebarPresentation(this.sidebarPreference, viewport.width) === "inline" },
      { component: session, basis: 0, grow: 1, minSize: 30 },
      { component: comparison, basis: 48, shrink: 1, minSize: 30,
        visible: (viewport) => this.split && secondary !== undefined && this.contentWidth(viewport.width) >= comparisonWidth },
      { component: this.resultScroll, basis: 0, grow: 1, minSize: 30,
        visible: (viewport) => this.showResult && this.contentWidth(viewport.width) >= resultBesideWidth },
    ], { gap: 1 }));
    this.tui.requestRender();
  }

  /** What the terminal leaves for sessions and their panels beside an inline sidebar. */
  private contentWidth(columns: number): number {
    return columns - (sidebarPresentation(this.sidebarPreference, columns) === "inline" ? sidebarWidth + 1 : 0);
  }

  private sessionState(session: SessionView): SidebarSessionState {
    return sidebarSessionState(session.blocked, session.ended,
      session.pending !== undefined && session.prompt !== "> ",
      session.progress?.value.phase ?? "none", session.unread);
  }

  /** Sessions in their visual and shortcut order: newest-created first, stable while activity changes. */
  private sessionOrder(): readonly SessionView[] {
    const inserted = [...this.sessions.values()];
    return inserted.map((_, visual) => inserted[newestFirstSourceIndex(inserted.length, visual)] as SessionView);
  }

  private updateSidebar(): void {
    this.sidebarHeader.setContext(basename(this.options.cwd), this.branch);
    const sessions: SidebarSession[] = this.sessionOrder().map((session) => ({
      id: session.id, title: session.title, state: this.sessionState(session), selected: session.id === this.selectedId,
    }));
    this.sidebar.setSessions(sessions);
    this.sidebar.setFrame(SHELL_SPINNER_FRAMES[this.frame] ?? "");
    this.sidebarScroll.updateLayout(this.sidebar.lineCount, Math.max(0, this.tui.terminal.rows - 2),
      () => this.tui.requestRender());
  }

  private updateResult(session: SessionView): void {
    const inspection = session.inspections[session.selectedInspection];
    if (inspection === undefined) {
      this.result.show(mutedText("No result yet. A review's full diff and check output appear here.", this.theme));
      this.result.diff.setDiff(undefined);
      return;
    }
    const note = session.selectedInspection < session.restoredInspectionCount ?
      "Recorded from an earlier run. Recheck before relying on it.\n" :
      session.selectedInspection < session.inspections.length - 1 ?
        "An earlier result. A pending decision applies to the latest one.\n" : "";
    const position = session.inspections.length > 1 ?
      mutedText(` ${session.selectedInspection + 1} of ${session.inspections.length} · Alt+, Alt+.`, this.theme) : "";
    this.result.show(`${bold(colorText(safeTerminalText(inspection.title), this.theme.accent))}${position}\n` +
      `${mutedText(note, this.theme)}`, inspection.detail);
    this.result.diff.setDiff(inspection.diff);
  }

  addSession(id: string, title: string, entries: readonly TranscriptEntry[] = [],
    inspections: readonly ShellInspection[] = [], fresh = entries.length === 0): void {
    if (this.sessions.has(id)) throw new Error("Tesota session already exists");
    const transcript = new Transcript(this.theme);
    const scroll = new ScrollView(transcript.container, { follow: "end", primary: true, scrollbar: "auto" });
    const welcome = fresh && entries.length === 0 ? new WelcomeBanner(this.options.cwd, this.theme, {
      viewportHeight: () => scroll.viewportHeight,
      // Replies to the operator show beneath the opening, which gives up their rows.
      rowsBelow: (width): number => transcript.container.children.reduce((rows: number, child) =>
        child === welcome ? rows : rows + child.render(width).length, 0),
      focused: () => this.terminalFocused,
      drafting: () => (id === this.selectedId ? this.editor.getText() : this.sessions.get(id)?.draft ?? "").length > 0,
      requestFrame: (delay) => { this.requestWelcomeFrame(delay); },
      reducedMotion: process.env["TESOTA_REDUCED_MOTION"] === "1",
    }) : undefined;
    if (welcome !== undefined) {
      if (this.terminalBackground !== undefined) welcome.setBackground(this.terminalBackground);
      transcript.container.addChild(welcome);
    }
    for (const entry of entries) transcript.add(entry);
    this.sessions.set(id, { id, title, transcript,
      ...welcome === undefined ? {} : { welcome },
      scroll,
      inspections: [...inspections], restoredInspectionCount: inspections.length,
      selectedInspection: inspections.length - 1,
      draft: "", pending: undefined, question: undefined, queued: [], progress: undefined,
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
    this.updateSubmit(session);
    this.compose();
    this.revealSelectedSession();
    this.tui.setFocus(this.editor);
    this.options.onSessionChange?.(id);
  }

  private revealSelectedSession(): void {
    const row = this.sidebar.rowFor(this.selectedId);
    if (row === undefined) return;
    const top = this.sidebarScroll.scrollTop;
    const height = this.sidebarScroll.viewportHeight;
    if (row < top) this.sidebarScroll.scrollTo(row);
    else if (height > 0 && row + 1 >= top + height) this.sidebarScroll.scrollTo(row - height + 2);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Pi's TUI asks terminals that speak the Kitty keyboard protocol to report releases too, and passes them to input
    // listeners; `matchesKey` matches a release as the key, so handling it would act twice per press.
    this.removeInputListener = this.tui.addInputListener((data) => isKeyRelease(data) ? undefined : this.handleKey(data));
    // The input takes what is typed from the start: an answer at a prompt, or a message for work under way.
    this.tui.setFocus(this.editor);
    this.compose();
    // Restored sessions are added before start; newest-first order can put the initial selection below the viewport.
    this.revealSelectedSession();
    this.tui.start();
    // The opening's fades blend toward the terminal's own background; the theme's usual one serves until it answers.
    void this.tui.queryTerminalBackgroundColor({ timeoutMs: 500 }).then((color) => {
      if (color === undefined) return;
      this.terminalBackground = [color.r, color.g, color.b];
      for (const session of this.sessions.values()) session.welcome?.setBackground(this.terminalBackground);
      this.tui.requestRender();
    }, () => { /* A terminal that does not answer keeps the theme's background. */ });
    let ticks = 0;
    this.timer = setInterval(() => {
      ticks += 1;
      const opening = this.selected();
      if (opening.welcome !== undefined && !opening.welcome.dismissed &&
        opening.welcome.drawnHeight !== opening.scroll.viewportHeight) this.tui.requestRender();
      const animate = [...this.sessions.values()].some((session) => animatedSidebarState(this.sessionState(session)));
      if (animate) {
        this.frame = (this.frame + 1) % SHELL_SPINNER_FRAMES.length;
        this.sidebar.setFrame(SHELL_SPINNER_FRAMES[this.frame] ?? "");
      }
      if (animate || ticks % Math.round(1_000 / spinnerMs) === 0) this.refreshElapsed();
    }, spinnerMs);
    this.timer.unref();
  }

  private handleKey(data: string): { consume: true } | undefined {
    if (matchesKey(data, "ctrl+c")) { this.stopOrQuit("Ctrl+C"); return { consume: true }; }
    if (this.handleAccountsKey(data)) return { consume: true };
    const question = this.selected().question;
    if (question !== undefined && this.answer(this.selected(), question, data)) return { consume: true };
    const menuInput = this.handleCommandMenuKey(data);
    if (menuInput !== undefined) return menuInput;
    if (matchesKey(data, "escape") && this.stopWork()) return { consume: true };
    if (matchesKey(data, "tab") && this.steer()) return { consume: true };
    if (matchesKey(data, "ctrl+d") && this.editor.getText().length === 0 && this.stopOrQuit("Ctrl+D")) return { consume: true };
    if (matchesKey(data, "ctrl+n")) { this.options.onNewSession?.(); return { consume: true }; }
    if (matchesKey(data, "ctrl+w")) { this.options.onCloseSession?.(this.selectedId); return { consume: true }; }
    if (this.handleSessionKey(data)) return { consume: true };
    const view = this.viewKeys.find(([key]) => matchesKey(data, key));
    // While a question waits, the hidden input takes nothing: what is typed there is never an answer.
    if (view === undefined) return question === undefined ? undefined : { consume: true };
    view[1]();
    return { consume: true };
  }

  /** The keys that change what the shell shows beside the conversation. */
  private readonly viewKeys: readonly (readonly [Parameters<typeof matchesKey>[1], () => void])[] = [
    ["alt+r", () => { this.showResult = !this.showResult; this.compose(); }],
    ["alt+b", () => { this.toggleSidebar(); }],
    ["alt+d", () => { this.toggleLatestNotice(); }],
    ["alt+,", () => { this.moveInspection(-1); }],
    ["alt+.", () => { this.moveInspection(1); }],
    ["alt+s", () => { this.split = !this.split; this.compose(); }],
  ];

  private toggleSidebar(): void {
    const presentation = sidebarPresentation(this.sidebarPreference, this.tui.terminal.columns);
    this.sidebarPreference = presentation === "hidden" ? "open" : "hidden";
    this.compose();
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
    this.returnQueued(session);
    return true;
  }

  /**
   * Work that stops takes its queued messages with it: they return to the
   * input, before anything typed there, to be sent again or changed, as in
   * Claude Code, rather than starting work the operator just stopped.
   */
  private returnQueued(session: SessionView): void {
    if (session.queued.length === 0) return;
    const current = session.id === this.selectedId ? this.editor.getText() : session.draft;
    const text = [...session.queued, current].filter((part) => part.trim().length > 0).join("\n");
    session.queued.length = 0;
    if (session.id === this.selectedId) this.editor.setText(text); else session.draft = text;
    this.updateQueue();
  }

  /**
   * `Tab` while the selected session works sends what is typed to its agent
   * now, as part of the turn; where the agent cannot take it, as between its
   * steps under review or on Claude Code, it is queued. False when there is
   * nothing to send, or the session is not working.
   */
  private steer(): boolean {
    const session = this.selected();
    const text = this.editor.getText();
    if (!this.working(session) || text.trim().length === 0 || shellCommand(text)) return false;
    this.editor.addToHistory(text);
    this.editor.setText("");
    if (this.options.onSteer?.(session.id, text) === true) this.record(session, { kind: "user", text }, true);
    else {
      this.replyTo(session.id, "The agent cannot take a message now; it is queued for after this turn.");
      session.queued.push(text);
    }
    this.updateQueue();
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
    const ids = this.sessionOrder().map((session) => session.id);
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

  private handleModelPickerKey(data: string): { consume: true } | undefined {
    if (!this.modelPicker.visible) return undefined;
    if (matchesKey(data, "up") || matchesKey(data, "down")) this.modelPicker.move(matchesKey(data, "up") ? -1 : 1);
    else if (matchesKey(data, "left") || matchesKey(data, "right")) this.modelPicker.shiftLevel(matchesKey(data, "left") ? -1 : 1);
    else if (matchesKey(data, "escape")) this.modelPicker.dismiss();
    else if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
      const [choice, prefix] = [this.modelPicker.choice, this.modelPicker.prefix];
      if (choice === undefined || prefix === undefined) return undefined;
      // A role is completed so its model can be chosen next; a model is chosen with Enter, or completed with Tab.
      const completed = `${prefix}${choice}${this.modelPicker.completes ? " " : ""}`;
      if (matchesKey(data, "enter") && !this.modelPicker.completes) this.submit(completed);
      else { this.editor.setText(completed); this.updateCommandMenu(completed); }
    } else return undefined;
    this.tui.requestRender();
    return { consume: true };
  }

  private handleCommandMenuKey(data: string): { consume: true } | undefined {
    const choice = this.handleChoicePickerKey(data);
    if (choice !== undefined) return choice;
    const theme = this.handleThemePickerKey(data);
    if (theme !== undefined) return theme;
    const picker = this.handleModelPickerKey(data);
    if (picker !== undefined) return picker;
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

  private handleThemePickerKey(data: string): { consume: true } | undefined {
    if (!this.themePicker.visible) return undefined;
    if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
      const choice = this.themePicker.choice;
      if (choice !== undefined) {
        if (matchesKey(data, "enter")) this.submit(`/themes ${choice}`);
        else this.editor.setText(`/themes ${choice}`);
      }
    } else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "escape")) {
      this.themePicker.handleInput(data);
    } else return undefined;
    this.tui.requestRender();
    return { consume: true };
  }

  private handleChoicePickerKey(data: string): { consume: true } | undefined {
    if (!this.choicePicker.visible) return undefined;
    if (matchesKey(data, "enter") || matchesKey(data, "tab")) {
      const [choice, prefix] = [this.choicePicker.choice, this.choicePicker.prefix];
      if (choice !== undefined && prefix !== undefined) {
        if (matchesKey(data, "enter")) this.submit(`${prefix}${choice}`);
        else this.editor.setText(`${prefix}${choice}`);
      }
    } else if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "escape")) {
      this.choicePicker.handleInput(data);
    } else return undefined;
    this.tui.requestRender();
    return { consume: true };
  }

  /**
   * Open the Accounts panel on a tab over the session, which keeps working
   * beneath it, and read its content: the roles at once, the saved usage at
   * once and then each fresh reading, and the sign-ins.
   */
  private openAccounts(session: SessionView, tab: AccountsTab): void {
    const source = this.options.accounts;
    if (source === undefined) { this.replyTo(session.id, "Accounts are not available in this shell.", "warning"); return; }
    this.accountsPanel.show(tab);
    if (this.accountsOverlay === undefined) {
      // Over the whole layout, sidebar included: accounts belong to no one session. A margin shows the layout still beneath.
      this.accountsOverlay = this.tui.showOverlay(this.accountsPanel, { width: `${ACCOUNTS_PANEL_WIDTH * 100}%`, minWidth: 40,
        maxHeight: `${ACCOUNTS_PANEL_HEIGHT * 100}%`, nonCapturing: true });
      this.tui.setBackdrop?.((line) => fadedText(line, this.theme));
    }
    this.readAccounts(source);
    this.tui.requestRender();
  }

  private readAccounts(source: AccountsSource): void {
    const read = ++this.accountsRead;
    const current = (): boolean => read === this.accountsRead && this.accountsOverlay !== undefined;
    this.accountsPanel.setRoles(source.roles());
    this.accountsPanel.setSignIns(undefined);
    void source.readUsage((usage) => {
      if (current()) { this.accountsPanel.setUsage(usage); this.tui.requestRender(); }
    }).catch(() => undefined);
    void source.readSignIns().then((signIns) => {
      if (current()) { this.accountsPanel.setSignIns(signIns); this.tui.requestRender(); }
    }, () => {
      if (current()) { this.accountsPanel.setSignIns(undefined, true); this.tui.requestRender(); }
    });
  }

  private closeAccounts(): void {
    this.accountsOverlay?.hide();
    this.accountsOverlay = undefined;
    this.tui.setBackdrop?.(undefined);
    this.tui.requestRender();
  }

  /** The open Accounts panel takes every key but Ctrl+C, so nothing typed reaches the prompt beneath it; Alt+A opens it. */
  private handleAccountsKey(data: string): boolean {
    if (this.accountsOverlay === undefined) {
      if (!matchesKey(data, "alt+a")) return false;
      this.openAccounts(this.selected(), "usage");
      return true;
    }
    const action = this.accountsPanel.handleKey(data);
    if (action === "close" || matchesKey(data, "alt+a")) this.closeAccounts();
    else if (action === "refresh" && this.options.accounts !== undefined) this.readAccounts(this.options.accounts);
    else if (typeof action === "object") {
      // The role's model is chosen in the same picker `/roles <role>` opens.
      this.closeAccounts();
      const opened = `/roles ${action.changeRole} `;
      this.editor.setText(opened);
      this.updateCommandMenu(opened);
    }
    this.tui.requestRender();
    return true;
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

  setTerminalFocused(focused: boolean): void {
    if (focused === this.terminalFocused) return;
    this.terminalFocused = focused;
    if (this.started) this.tui.requestRender();
  }

  /** One pending frame for the selected session's opening; it asks again from its render while it still needs one. */
  private requestWelcomeFrame(delay: number): void {
    if (!this.started || this.welcomeFrame !== undefined) return;
    this.welcomeFrame = setTimeout(() => {
      this.welcomeFrame = undefined;
      if (this.selected().welcome?.dismissed === false) this.tui.requestRender();
    }, delay);
    this.welcomeFrame.unref();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.closeAccounts();
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.welcomeFrame !== undefined) clearTimeout(this.welcomeFrame);
    this.welcomeFrame = undefined;
    this.timer = undefined;
    this.removeInputListener?.();
    this.removeInputListener = undefined;
    for (const session of this.sessions.values()) this.cancelPrompt(session);
    this.tui.terminal.setProgress(false);
    // A session's mark would go stale once the shell has exited.
    this.tui.terminal.setTitle("Tesota");
    this.windowTitle = "";
    this.tui.stop({ preserveScreen: true });
    const lastMessage = this.selected().transcript.lastMessage;
    if (lastMessage.length > 0) {
      const lines = new Text(lastMessage, 0, 0).render(this.tui.terminal.columns);
      this.tui.terminal.write(lines.join("\r\n") + "\r\n");
    }
  }

  private record(session: SessionView, entry: TranscriptEntry, persist: boolean): void {
    // What becomes part of the session ends its opening; a reply to the operator only shows beneath it.
    if (persist) session.welcome?.dismiss();
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

  replyTo(id: string, text: string, tone: NoticeTone = "info"): void {
    const content = text.trim();
    if (content.length > 0) this.record(this.find(id), { kind: "notice", text: content, tone }, false);
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

  setBranch(branch: string | undefined): void {
    this.branch = branch;
    if (this.started) this.compose();
  }

  setSessionPlan(id: string, plan: WorkPlan | undefined): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    if (plan === undefined) delete session.plan; else session.plan = plan;
    if (this.started && id === this.selectedId) this.compose();
  }

  setSessionModel(id: string, model: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.model = model;
    if (this.started && id === this.selectedId) this.compose();
  }

  setSessionTitle(id: string, title: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.title = title;
    if (this.started) this.compose();
  }

  setSessionExecution(id: string, label: string, place: SessionExecution["commands"]): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.execution = { label, place };
    if (this.started && id === this.selectedId) this.compose();
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
      if (this.contentWidth(this.tui.terminal.columns) >= resultBesideWidth) this.showResult = true;
      this.compose();
    }
  }

  blockSession(id: string): void {
    const session = this.find(id);
    session.blocked = true;
    // A prompt waiting when the session is blocked, such as after a revert that needs recovery, ends with it.
    const pending = session.pending;
    session.pending = undefined;
    session.question = undefined;
    pending?.reject(new SessionBlockedError());
    this.returnQueued(session);
    this.updateSubmit(session);
    this.updateSidebar();
    this.refreshElapsed();
  }

  removeSession(id: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    if (this.sessions.size === 1) throw new Error("The last Tesota session cannot be removed");
    if (id === this.selectedId) this.selectSession(sessionBeside(this.sessionOrder().map((item) => item.id), id, 1));
    const pending = session.pending;
    session.pending = undefined;
    session.question = undefined;
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
    this.returnQueued(session);
    this.updateSubmit(session);
    this.updateSidebar();
    this.refreshElapsed();
  }

  ask(prompt: string): Promise<string> { return this.askIn(this.selectedId, prompt); }

  /** The session that can be asked something now, or why it cannot. */
  private askable(id: string): SessionView | Error {
    const session = this.sessions.get(id);
    if (session === undefined) return new Error("Tesota session unavailable");
    if (session.blocked) return new SessionBlockedError();
    if (session.ended) return new Error("Tesota session has ended");
    if (session.pending !== undefined) return new Error("Tesota Shell prompt already active");
    return session;
  }

  chooseIn<V extends string>(id: string, question: ShellQuestion<V>): Promise<V> {
    const session = this.askable(id);
    if (session instanceof Error) return Promise.reject(session);
    session.prompt = question.title;
    session.question = new QuestionPanel(question, this.theme);
    const answer = new Promise<string>((resolve, reject) => { session.pending = { resolve, reject }; });
    if (id === this.selectedId) this.updateCommandMenu(this.editor.getText());
    this.updateSidebar();
    this.refreshElapsed();
    return answer.then((value) => {
      const option = question.options.find((entry) => entry.value === value);
      if (option === undefined) throw new Error("Tesota Shell question received an unavailable answer");
      return option.value;
    });
  }

  /** Answer a session's question from a key; false when the key is neither one of its answers nor an arrow. */
  private answer(session: SessionView, question: QuestionPanel, data: string): boolean {
    const picked = question.handleKey(data);
    if (picked === undefined) return false;
    if (picked !== "moved") {
      const pending = session.pending;
      session.pending = undefined;
      session.question = undefined;
      session.prompt = "> ";
      if (picked.decided !== undefined) this.writeTo(session.id, picked.decided.text, picked.decided.tone);
      this.updateCommandMenu(this.editor.getText());
      this.refreshElapsed();
      pending?.resolve(picked.value);
    }
    this.tui.requestRender();
    return true;
  }

  askIn(id: string, prompt: string): Promise<string> {
    const session = this.askable(id);
    if (session instanceof Error) return Promise.reject(session);
    if (prompt === "> ") {
      session.transcript.settle();
      // The first prompt may appear while the environment is still preparing; that progress stays visible.
      if (session.progress?.value.phase !== "preparing") session.progress = undefined;
      // A message typed while the session worked is the next request, sent as if typed now.
      const next = session.queued.shift();
      if (next !== undefined) {
        this.record(session, { kind: "user", text: next }, true);
        if (id === this.selectedId) this.updateQueue();
        this.refreshElapsed();
        return Promise.resolve(next);
      }
    }
    session.prompt = prompt;
    const answer = new Promise<string>((resolve, reject) => { session.pending = { resolve, reject }; });
    if (id === this.selectedId) {
      this.tui.setFocus(this.editor);
      this.updateCommandMenu(this.editor.getText());
    }
    this.updateSidebar();
    this.refreshElapsed();
    return answer;
  }

  hasQueued(id: string): boolean { return (this.sessions.get(id)?.queued.length ?? 0) > 0; }

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
    if (this.question.children[0] !== session.question) {
      this.question.clear();
      if (session.question !== undefined) this.question.addChild(session.question, { minSize: 1 });
    }
    const progress = session.progress;
    let text: string;
    let whole = false;
    const quit = this.quitArmed;
    if (quit !== undefined && this.now() - quit.at <= CONFIRMATION_WINDOW_MS) {
      const working = [...this.sessions.values()].some((entry) => busy(entry.progress?.value));
      text = working ? colorText(`Press ${quit.key} again to quit. Running work stops; its changes stay where it made them.`,
        this.theme.warning) : mutedText(`Press ${quit.key} again to quit. Sessions are restored next time.`, this.theme);
    } else if (session.blocked) text = colorText("Unresolved effects. Run tesota recover before new work.", this.theme.warning);
    else if (session.ended) text = mutedText("Session ended. Ctrl+N starts a new one; Ctrl+W closes this one.", this.theme);
    else if (session.question !== undefined) text = bold(colorText("Waiting for your decision", this.theme.warning));
    else if (session.pending !== undefined && session.prompt !== "> ") {
      text = bold(colorText(safeTerminalText(session.prompt.trim()), this.theme.warning));
      whole = true;
    } else if (progress !== undefined) {
      const elapsed = Math.max(0, Math.floor((this.now() - progress.startedAt) / 1_000));
      const spinner = busy(progress.value) ?
        `${colorText(SHELL_SPINNER_FRAMES[this.frame] ?? "", this.theme.accent)} ` : "";
      const label = safeTerminalText(tesotaShellProgressLabel(progress.value));
      text = `${spinner}${colorText(label, this.theme.accent)} ${mutedText(`· ${elapsed}s`, this.theme)}`;
    } else text = mutedText("Ready", this.theme);
    this.status.setText(text, whole);
    this.tui.terminal.setProgress(!session.blocked && busy(progress?.value));
    this.updateWindowTitle(session);
  }

  /**
   * The terminal's title, which its tabs and task switcher show, seen from
   * elsewhere: a mark for every session, with a session waiting on the
   * operator first, then the selected session's name, and how many others
   * wait so the mark is not taken for it. Written only when it changes.
   */
  private updateWindowTitle(session: SessionView): void {
    if (!this.started) return;
    const states = [...this.sessions.values()].map((entry) => this.sessionState(entry));
    const waiting = states.filter(attentionSidebarState).length;
    const own = this.sessionState(session);
    const frame = SHELL_SPINNER_FRAMES[this.frame] ?? "";
    const kind = terminalTitleMark(waiting, states.filter(animatedSidebarState).length);
    const mark = kind === "attention" ? "!" : kind === "working" ? frame : sessionStateIcon(own, frame);
    const others = otherSessionsWaiting(waiting, attentionSidebarState(own));
    const title = `${mark} ${safeTerminalText(session.title.replace(/\s+/gu, " "))}` +
      (others === 0 ? "" : ` · ${others} waiting`);
    if (title === this.windowTitle) return;
    this.windowTitle = title;
    this.tui.terminal.setTitle(title);
  }

  private submit(answer: string): void {
    const session = this.selected();
    if (this.working(session)) { this.queueMessage(session, answer); return; }
    const pending = session.pending;
    if (pending === undefined) return;
    if (session.prompt === "> " && shellCommand(answer)) {
      session.draft = "";
      this.editor.setText("");
      this.runShellCommand(session, answer.trim());
      return;
    }
    session.pending = undefined;
    session.draft = "";
    this.commandMenu.update("", false);
    if (answer.length > 0) {
      this.editor.addToHistory(answer);
      this.record(session, { kind: "user", text: answer }, true);
    }
    session.prompt = "> ";
    this.refreshElapsed();
    pending.resolve(answer);
  }

  /**
   * Enter while the session works queues the message for its next request,
   * where it becomes a turn of its own; a shell command stays in the input,
   * since commands such as `/model` change what the running work uses.
   */
  private queueMessage(session: SessionView, text: string): void {
    if (shellCommand(text)) {
      this.editor.setText(text);
      this.replyTo(session.id, "Shell commands run at the prompt once this work ends; the command stays in the input.", "warning");
      return;
    }
    if (text.trim().length === 0) return;
    this.editor.addToHistory(text);
    session.queued.push(text);
    this.updateQueue();
    this.tui.requestRender();
  }

  /** Each shell command, by name: what it does with the selected session and its arguments. */
  private readonly commandHandlers: Readonly<Record<string, (session: SessionView, args: readonly string[]) => void>> = {
    new: () => { this.options.onNewSession?.(); },
    next: () => { this.selectSession(sessionBeside(this.sessionOrder().map((item) => item.id), this.selectedId, 1)); },
    previous: () => { this.selectSession(sessionBeside(this.sessionOrder().map((item) => item.id), this.selectedId, -1)); },
    close: (session) => { this.options.onCloseSession?.(session.id); },
    rename: (session, args) => { this.options.onRename?.(session.id, args.length === 0 ? undefined : args.join(" ")); },
    model: (session, args) => { this.changeModel(session, args); },
    roles: (session, args) => { this.changeRoleModel(session, args); },
    handoff: (session) => { this.options.onHandoff?.(session.id); },
    keep: (session) => { this.options.onKeep?.(session.id); },
    revert: (session, args) => { this.options.onRevert?.(session.id, args); },
    redo: (session) => { this.options.onRedo?.(session.id); },
    isolate: (session) => { this.options.onIsolate?.(session.id); },
    checks: (session, args) => { this.options.onChecks?.(session.id, args); },
    sandbox: (session, args) => { this.changeSandbox(session, args); },
    accounts: (session, args) => {
      const tab = args[0] ?? "usage";
      if (args.length > 1 || !(ACCOUNTS_TABS as readonly string[]).includes(tab)) {
        this.replyTo(session.id, `Use /accounts or /accounts <${ACCOUNTS_TABS.join("|")}>.`, "warning");
      } else this.openAccounts(session, tab as AccountsTab);
    },
    usage: (session, args) => {
      if (args.length > 0) this.replyTo(session.id, "Use /usage; it shows every account. tesota usage <route> reads one.", "warning");
      else this.openAccounts(session, "usage");
    },
    result: () => { this.showResult = !this.showResult; this.compose(); },
    sidebar: () => { this.toggleSidebar(); },
    themes: (session, args) => {
      if (args.length === 0) this.editor.setText("/themes ");
      else this.changeTheme(session, args);
    },
    details: (session, args) => { this.toggleDetails(session, args); },
    help: (session) => {
      this.replyTo(session.id, "Commands: /new /next /previous /close /rename [name] /model [route:model] /roles [role] [route:model|default|off] " +
        "/handoff /sandbox [where] /isolate /keep /revert [all|agent] /redo /checks [reset] /accounts [tab] /usage /result /sidebar /themes [name] " +
        "/details [number] /help /quit\n" +
        "While it works: Enter queues · Tab sends to the agent now · Esc or Ctrl+C stops · Ctrl+C or Ctrl+D twice quits\n" +
        "Sessions: Ctrl+N new · Alt+J next · Alt+K previous · Alt+1…9 by position · Ctrl+W close\n" +
        "View: Alt+R result · Alt+B sidebar · Alt+D details · Alt+S split · Alt+A accounts");
    },
    quit: () => { this.options.onQuit?.(); },
  };

  private runShellCommand(session: SessionView, input: string): void {
    const [command = "", ...args] = input.slice(1).split(/\s+/u);
    const run = Object.hasOwn(this.commandHandlers, command) ? this.commandHandlers[command] : undefined;
    if (run === undefined) this.replyTo(session.id, "Unknown command. Type / for commands or /help for shortcuts.", "warning");
    else run(session, args);
  }

  private changeModel(session: SessionView, args: readonly string[]): void {
    if (args.length > 1) this.replyTo(session.id, "Use /model or /model <route:model>.", "warning");
    else if (args.length === 0 && this.options.modelPicker !== undefined && session.pending !== undefined) {
      // `/model` alone opens the picker, filtered by what is typed after it.
      this.editor.setText("/model ");
      this.updateCommandMenu("/model ");
    } else this.options.onModel?.(session.id, args[0]);
  }

  private changeTheme(session: SessionView, args: readonly string[]): void {
    const name = parseTesotaShellTheme(args[0] ?? "");
    if (args.length !== 1 || name === undefined) {
      this.replyTo(session.id, `Use /themes to choose, or /themes <${TESOTA_SHELL_THEME_NAMES.join("|")}>.`, "warning");
      return;
    }
    Object.assign(this.theme, tesotaShellTheme(name));
    initTheme(this.theme.appearance === "light" ? "light" : "dark");
    for (const view of this.sessions.values()) view.scroll.invalidate();
    this.result.diff.invalidate();
    this.editor.invalidate();
    this.compose();
    this.replyTo(session.id, `Theme: ${name}.`);
  }

  private changeSandbox(session: SessionView, args: readonly string[]): void {
    if (args.length > 1) this.replyTo(session.id, "Use /sandbox or /sandbox <auto|wsl|docker|host|default>.", "warning");
    else if (args.length === 0 && this.options.sandboxPicker !== undefined && session.pending !== undefined) {
      this.editor.setText("/sandbox ");
      this.updateCommandMenu("/sandbox ");
    }
    else this.options.onSandbox?.(session.id, args[0]);
  }

  private changeRoleModel(session: SessionView, args: readonly string[]): void {
    if (args.length < 2 && this.options.modelPicker !== undefined && session.pending !== undefined) {
      // `/roles` opens the role picker, and `/roles <role>` that role's model picker.
      const opened = args.length === 0 ? "/roles " : `/roles ${args[0]} `;
      this.editor.setText(opened);
      this.updateCommandMenu(opened);
    } else this.options.onRoleModel?.(session.id, args);
  }

  private toggleDetails(session: SessionView, args: readonly string[]): void {
    if (args.length === 0 && session.transcript.noticePreviews.length > 0 && session.pending !== undefined) {
      this.editor.setText("/details ");
      this.updateCommandMenu("/details ");
      return;
    }
    const number = args.length === 0 ? 1 : Number(args[0]);
    if (!Number.isSafeInteger(number) || number < 1 || args.length > 1 || !session.transcript.toggleNotice(number - 1)) {
      this.replyTo(session.id, "No long notice at that number. Use /details or /details 2.", "warning");
    } else this.tui.requestRender();
  }

  private cancelPrompt(session: SessionView): void {
    const pending = session.pending;
    if (pending === undefined) return;
    session.pending = undefined;
    // A cancelled question leaves the input as it was: the operator's draft was never its answer.
    if (session.question !== undefined) session.question = undefined;
    else if (session.id === this.selectedId) this.editor.setText("");
    pending.reject(new DOMException("cancelled", "AbortError"));
    this.updateSidebar();
    this.refreshElapsed();
  }
}

export function createTesotaShellTerminal(options: TesotaShellTerminalOptions): TesotaShellTerminal {
  return new PersistentTesotaShellTerminal(options);
}
