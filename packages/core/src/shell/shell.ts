import {
  type Component, Container, Editor, type Focusable, Input, Loader, matchesKey, ScrollView, type SelectItem, SelectList,
  type SlashCommand,
  Spacer, type Terminal, type TerminalColors, Text, TruncatedText, TuiAltScreen, type TuiAltScreenOptions, TuiMainScreen, VStack,
} from "@earendil-works/pi-tui";
import { type FooterData, type Mounted, QUESTION_STATUS, type WorkingDetail } from "../../../../src/contract.ts";
import type { SessionEvent } from "../loop.ts";
import { providerError } from "../provider-error.ts";
import type { EngineSession } from "../session.ts";
import type { TuiMode } from "../settings.ts";
import { copyToClipboard } from "./clipboard.ts";
import { FileAutocompleteProvider } from "./autocomplete.ts";
import { expandKey, type Surface } from "./surface.ts";
import { listRow, type ShellTheme } from "../../../../src/theme.ts";
import type { ClarificationQuestion } from "../../../../src/clarification.ts";
import { Transcript } from "./transcript.ts";
import type { QuestionOutcome, QuestionSubmit } from "../questions.ts";
import { createQuestionDraft, type QuestionDraft, QuestionForm } from "./question.ts";
import { framed, frameTitle, type FrameTone } from "./frame.ts";
import { terminalText } from "../../../../src/terminal-text.ts";

const queueReplyKey = { key: "alt+enter", label: "Alt+Enter" } as const;
const stopRunKey = { key: "escape", label: "Esc" } as const;
const verifyingLabel = (detail?: string): string => `Verifying… · ${queueReplyKey.label}: queue reply · ${stopRunKey.label}: stop${detail === undefined ? "" : `\n${detail}`}`;

/** The fullscreen renderer that draws every cell on every frame, for terminals that leave stale fragments otherwise. */
class RepaintingAltScreen extends TuiAltScreen {
  override requestRender(_force?: boolean): void { super.requestRender(true); }
}

export interface ShellOptions {
  readonly terminal: Terminal;
  readonly mode: TuiMode;
  /** Draw every cell on every frame; Windows ConPTY hosts need it (#432). */
  readonly fullRepaint: boolean;
  readonly theme: ShellTheme;
  readonly session: EngineSession;
  /** What the footer says of the model and the session. */
  readonly status: () => string;
  /** Runs a `/command`; resolves false when there is no such command. */
  readonly command?: (text: string) => Promise<boolean>;
  /** The commands offered in the editor, from the same definitions that run them. */
  readonly commands?: readonly SlashCommand[];
  /** Copies selected text; the operator's clipboard when not given. Resolves true once it could be checked. */
  readonly copy?: (text: string) => Promise<boolean>;
  /** What the session's extensions draw (#446): header, editor, footer, working indicator, messages and tools. */
  readonly surface?: Surface;
  /** What an extension's footer reads besides the session. */
  readonly footerData?: FooterData;
  /** Turns to the next permission mode, on Shift+Tab (#449). */
  readonly nextMode?: () => void;
  /** Opens the sessions' dashboard, on Ctrl+T (#455). */
  readonly agents?: () => void;
}

/** A line the operator types without it showing, for keys and tokens. */
class SecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  handleInput(data: string): void {
    if (matchesKey(data, "enter")) this.onSubmit?.(this.value);
    else if (matchesKey(data, "escape")) this.onEscape?.();
    else if (matchesKey(data, "backspace")) this.value = this.value.slice(0, -1);
    // Typed and pasted text, without the terminal's paste markers.
    else this.value += [...data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "")].filter((char) => char >= " " && char !== "\x7f")
      .join("");
  }
  invalidate(): void { /* nothing cached */ }
  render(): string[] { return [`> ${"•".repeat(this.value.length)}`]; }
}

/** What a permission question shows: what is asked, the command or change in its own block, and why it asks. */
export interface Confirmation {
  readonly title: string;
  readonly body?: string;
  readonly note?: string;
  readonly items: readonly SelectItem[];
}

/** pi-tui owns layout and interaction; the shell supplies the width of the selection band. */
class BandedList extends SelectList implements Focusable {
  focused = false;
  readonly #look: ShellTheme;
  constructor(items: SelectItem[], maxVisible: number, theme: ShellTheme) {
    super(items, maxVisible, theme.selectList);
    this.#look = theme;
  }
  override render(width: number): string[] {
    return super.render(width).map((line) => listRow(this.#look, line, width));
  }
}

/** A list whose numbered items a digit picks at once, as Claude Code and Codex answer a permission. */
class NumberedList extends BandedList {
  readonly #items: readonly SelectItem[];
  constructor(items: SelectItem[], maxVisible: number, theme: ShellTheme) {
    super(items, maxVisible, theme);
    this.#items = items;
  }
  override handleInput(data: string): void {
    const index = /^[1-9]$/u.test(data) ? Number(data) - 1 : -1;
    const item = this.#items[index];
    if (item === undefined) { super.handleInput(data); return; }
    this.setSelectedIndex(index);
    this.onSelect?.(item);
  }
}


/** A running shell: what it draws, and how it ends. */
export interface Shell {
  /** Asks the operator to choose one of `items`; undefined when they cancel. */
  pick(title: string, items: readonly SelectItem[]): Promise<string | undefined>;
  /** Asks the operator to allow something (#449), set apart by a bar: numbered choices a digit picks; undefined when they cancel. */
  confirm(question: Confirmation): Promise<string | undefined>;
  /** Asks the operator for a line of text, hidden when `secret`; undefined when they cancel. */
  ask(message: string, options?: { readonly secret?: boolean; readonly placeholder?: string }): Promise<string | undefined>;
  /**
   * Shows `session` instead, its conversation drawn from its history (#455):
   * with its own surface when it has one, so its header, editor and footer
   * are its own, and as working or verifying when its run is going.
   */
  show(session: EngineSession, surface?: Surface, state?: "working" | "settling"): void;
  /** Shows `body` over the whole shell with the keyboard's focus; the returned function takes it away again. */
  overlay(body: Component & { dispose?: () => void }): () => void;
  /**
   * Shows `body` as a dialog under `title`, framed and in the input's place as
   * `pick` and `confirm` are, with the keyboard's focus, until the returned
   * function takes it away and disposes of it, or the shell stops.
   */
  panel(title: string, body: Component & Focusable & { dispose?: () => void }): () => void;
  /** Registers an explicit batch of operator questions for `owner`, and removes it when its run releases the callback. */
  askUser(owner: EngineSession, questions: readonly ClarificationQuestion[], submit: QuestionSubmit,
    finish: (outcome: Exclude<QuestionOutcome, { readonly status: "answered" }>) => void): () => void;
  /** Tells every pending question owned by `owner` that its session can no longer accept an answer. */
  cancelQuestions(owner: EngineSession, reason: string): void;
  /** Shows the shown session's run as working, verifying or idle, when it goes on without saying so (#455). */
  busy(state: "working" | "settling" | undefined): void;
  /** Writes a line of the shell's own into the conversation. */
  note(text: string, tone?: "muted" | "error" | "warning"): void;
  /** Draws the footer again, as `status` now says it. */
  redraw(): void;
  /** Gives the terminal to another program for as long as `work` runs, such as Claude Code's sign-in (#642), then draws the shell again. */
  handOver<T>(work: () => Promise<T>): Promise<T>;
  /** Ends the shell, leaving the conversation in the terminal's scrollback; settles once it has. */
  stop(): void;
  /** Settles when the shell has stopped. */
  readonly stopped: Promise<void>;
}

/**
 * The engine's terminal shell for one session (#444): the conversation above,
 * the editor, a working indicator and the footer below. Fullscreen it scrolls
 * the conversation itself, with search and in-app copy; inline it prints into
 * the terminal's scrollback. Enter sends, and steers while the agent works;
 * Alt+Enter queues a follow-up; Esc stops the run; Ctrl+C clears the editor
 * and, twice on an empty one, ends the shell, as Ctrl+D on an empty one does.
 * On ending, a fullscreen shell writes the conversation to the scrollback,
 * as Pi does. What the session's extensions draw (#446), its header, editor,
 * footer and working indicator, takes the shell's own place as they set it,
 * and Ctrl+O expands their messages and tool calls.
 */
export function startShell(options: ShellOptions): Shell {
  const { theme, terminal } = options;
  let session = options.session;
  let busy = false;
  const copy = options.copy ?? (async (text: string) => copyToClipboard(text, (data) => terminal.write(data)));
  const altOptions: TuiAltScreenOptions = {
    searchMatchStyle: (text) => theme.underline(theme.bg("searchMatchBg", theme.fg("searchMatchText", text))),
    searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(theme.bg("searchMatchBg", theme.fg("searchMatchText", text)))),
    scrollToEndIndicator: () => theme.bg("selectedBg", theme.fg("text", " ↓ Jump to latest message ")),
    copyOnSelect: true,
    copySelection: async (text) => await copy(text) || "copied through the terminal",
  };
  const tui = options.mode === "inline" ? new TuiMainScreen(terminal)
    : options.fullRepaint ? new RepaintingAltScreen(terminal, false, undefined, altOptions) : new TuiAltScreen(terminal, false, undefined, altOptions);

  /** The shown session's surface: each session's extensions draw on their own (#455). */
  let surface = options.surface;
  let expanded = false;
  const document = new Container();
  const none = new Map();
  const transcript = new Transcript(theme, {
    get renderers() { return surface?.renderers ?? none; }, get tools() { return surface?.tools ?? none; },
    // The shown session's folder, its worktree when it has one (#453), never the process's.
    expanded: () => expanded, get cwd() { return session.workspace.cwd; } });
  transcript.load(session.history());
  let activity = session.history().length > 0;
  let handedOver = false;
  let mountedHeader: Mounted | undefined;
  const header = new Container();
  document.addChild(header);
  // A blank row between the header and the conversation's first entry.
  document.addChild(new Spacer(1));
  document.addChild(transcript);
  // Derived from the shown session, not a transient event: history reloads and session switches keep it (#713).
  document.addChild({
    render: (width) => {
      const awaiting = session.awaiting();
      return awaiting === undefined ? [] : new Text(theme.fg("warning", terminalText(awaiting)), 1, 1).render(width);
    },
    invalidate: () => undefined,
  });
  /** The gate's live block while it verifies (#591), after the conversation and apart from it, so a reload keeps it. */
  const block = new Container();
  document.addChild(block);
  // Pi uses Alt+Q on Windows, where Alt+Up is not reliably passed through by consoles.
  const dequeueKey = process.platform === "win32" ? "alt+q" : "alt+up";
  const dequeueHint = process.platform === "win32" ? "Alt+Q" : "Alt+Up";
  const pending = new Container();
  const drawPending = (): void => {
    pending.clear();
    for (const message of session.pendingMessages()) {
      const label = message.behavior === "steer" ? "Steer (next model turn)" : "Follow-up (when the run ends)";
      pending.addChild(new TruncatedText(theme.fg("dim", `${label}: ${terminalText(message.text).replaceAll("\n", " ")}`), 1, 0));
    }
    if (pending.children.length > 0) pending.addChild(new TruncatedText(theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`), 1, 0));
  };
  drawPending();
  const status = new Container();
  const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "Working…");
  const editorSlot = new VStack();
  let editor = new Editor(tui, theme.editor);
  /** The shell's commands, then the shown session's skills (#540); a command wins over a skill of its name. */
  const autocomplete = (): FileAutocompleteProvider => {
    const commands = options.commands ?? [];
    const skills = session.skills().filter(({ name }) => !commands.some((command) => command.name === name))
      .map(({ name, description }) => ({ name, description }));
    return new FileAutocompleteProvider([...commands, ...skills], session.workspace.cwd);
  };
  const footerSlot = new Container();
  const footer = new Text("", 1, 0);
  const drawFooter = (): void => { footer.setText(theme.fg("dim", options.status())); };
  drawFooter();
  // While a question waits in the input's place the run waits for the operator, as the footer says, so it does not
  // also show as working: the question leads, directly under the conversation.
  const statusRow: Component = { render: (width) => questions.length > 0 ? [] : status.render(width), invalidate: () => { status.invalidate(); } };
  // A blank row always above the input, so the conversation's last card never touches it.
  const dock: readonly Component[] = [new Spacer(1), pending, statusRow, editorSlot, footerSlot];
  // This decoration belongs to the live viewport, not the document exported to scrollback.
  const liveDocument = new Container();
  liveDocument.addChild(document);
  liveDocument.addChild({
    render: (width) => {
      const stage = mountedHeader?.emptyState;
      if (activity || handedOver || stage === undefined) { stage?.pause(); return []; }
      const free = Math.max(0, terminal.rows - document.render(width).length
        - dock.reduce((rows, component) => rows + component.render(width).length, 0));
      return stage.renderIn(width, free);
    },
    handleMouse: (event) => activity ? undefined : mountedHeader?.emptyState?.handleMouse?.(event),
    invalidate: () => mountedHeader?.emptyState?.invalidate(),
  });
  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(new VStack([
      { component: new ScrollView(liveDocument, { follow: "end", primary: true, overscroll: "chain" }), basis: 0, grow: 1, shrink: 1, minSize: 1 },
      // The footer never gives up its row: what waits for the operator, and the mode, show however tall a question is.
      { component: new VStack(dock.map((component) => ({ component, shrink: component === footerSlot ? 0 : 1, minSize: 0 }))), basis: "auto", grow: 0, shrink: 1,
        minSize: 1 },
    ]));
  } else {
    tui.addChild(liveDocument);
    for (const component of dock) tui.addChild(component);
  }

  /** What has the keyboard over the shell, a dialog or the dashboard (#455): the editor takes it back only when nothing does. */
  let covering: Component | undefined;
  /** What `overlay` shows over the shell: while it does, a question waits in the input's place under it without the keyboard. */
  let overlayBody: (Component & { dispose?: () => void }) | undefined;
  let hideOverlay: (() => void) | undefined;
  /** The keyboard back to the latest question, or the editor, unless an overlay has it. */
  const refocus = (): void => {
    if (overlayBody !== undefined) return;
    covering = questions.at(-1)?.body;
    tui.setFocus(covering ?? editor);
  };
  /** What closes each dialog `panel` shows, so stopping the shell disposes of it. */
  const openPanels = new Set<() => void>();
  /** The questions shown in the input's place, the latest in front: a permission, a picker, a prompt. */
  const questions: { readonly box: Component; readonly body: Component & Focusable }[] = [];
  /** The input's slot: the latest question while one waits, the editor otherwise; the footer says when one waits. */
  const showSlot = (): void => {
    editorSlot.clear();
    editorSlot.addChild(questions.at(-1)?.box ?? editor);
    if (questions.length > 0) surface?.statuses.set(QUESTION_STATUS, "waiting for you");
    else surface?.statuses.delete(QUESTION_STATUS);
  };
  interface ClarificationMount {
    readonly question: { readonly box: Component; readonly body: Component & Focusable };
    readonly generation: number;
  }
  interface ClarificationRegistration {
    readonly owner: EngineSession;
    readonly questions: readonly ClarificationQuestion[];
    readonly submit: QuestionSubmit;
    readonly draft: QuestionDraft;
    readonly finish: (outcome: Exclude<QuestionOutcome, { readonly status: "answered" }>) => void;
    mount: ClarificationMount | undefined;
    released: boolean;
    generation: number;
  }
  /** Registered calls survive a session switch; only their visible mount is detached. */
  const clarifications = new Map<EngineSession, Set<ClarificationRegistration>>();
  let visibleClarification: ClarificationRegistration | undefined;
  const removeQuestion = (question: { readonly box: Component; readonly body: Component & Focusable }): void => {
    const index = questions.indexOf(question);
    if (index >= 0) questions.splice(index, 1);
  };
  const detachClarification = (): void => {
    const visible = visibleClarification;
    if (visible === undefined) return;
    const body = visible.mount?.question.body;
    if (visible.mount !== undefined) removeQuestion(visible.mount.question);
    visible.mount = undefined;
    visibleClarification = undefined;
    showSlot();
    if (covering === body) {
      covering = questions.at(-1)?.body;
      tui.setFocus(covering ?? editor);
    }
  };
  const mountClarification = (registration: ClarificationRegistration): void => {
    if (ending || overlayBody !== undefined || registration.released || registration.owner !== session || visibleClarification === registration) return;
    detachClarification();
    const generation = registration.generation + 1;
    const active = (): boolean => visibleClarification === registration && registration.mount?.generation === generation && !registration.released;
    // No heading of its own: the question is the form's title, and the call above it says who asks.
    const inlineViewport = tui instanceof TuiMainScreen ? {
      height: (width: number): number => Math.max(1, terminal.rows - form.footerLines(width).length
        - dock.filter((component) => component !== editorSlot).reduce((rows, component) => rows + component.render(width).length, 0)),
      redraw: (): void => { tui.requestRender(); },
    } : undefined;
    const form = new QuestionForm(registration.questions, (answers) => active() ? registration.submit(answers) : "This question is no longer active.",
      () => { if (active()) registration.finish({ status: "cancelled", reason: "The operator dismissed the question." }); }, theme, registration.draft, active, inlineViewport);
    const question = { box: new VStack(), body: form };
    // The choices scroll; the hint and a refusal stay under them.
    question.box.addChild(form, { shrink: 1, minSize: 1 });
    question.box.addChild({ render: (width) => form.footerLines(width), invalidate: () => undefined }, { shrink: 0 });
    const mount = { question, generation };
    registration.generation = generation;
    registration.mount = mount;
    visibleClarification = registration;
    questions.push(question);
    showSlot();
    covering = form;
    tui.setFocus(form);
    tui.requestRender();
  };
  const mountClarificationsFor = (owner: EngineSession): void => {
    const registrations = clarifications.get(owner);
    const registration = registrations === undefined ? undefined : [...registrations].at(-1);
    if (registration !== undefined) mountClarification(registration);
  };
  /** Each session's unsent text, kept while another is shown (#455). */
  const drafts = new Map<EngineSession, string>();
  /** What each slot was last built from, so a change rebuilds only what changed and the editor keeps its text otherwise. */
  let mounted: { header?: unknown; editor?: unknown; footer?: unknown } = {};
  let disposers: (() => void)[] = [];
  const mountHeader = (): void => {
    if (mounted.header === surface?.header && header.children.length > 0) return;
    mounted.header = surface?.header;
    mountedHeader?.dispose?.();
    header.clear();
    mountedHeader = surface?.header === undefined ? new Text(theme.fg("dim", `tesota-core · ${session.workspace.cwd}`), 1, 1)
      : surface.header(tui, theme);
    header.addChild(mountedHeader);
  };
  const mountEditor = (): void => {
    if (mounted.editor === surface?.editor && editorSlot.children.length > 0) return;
    mounted.editor = surface?.editor;
    const text = editor.getText();
    editor = surface?.editor === undefined ? new Editor(tui, theme.editor)
      : surface.editor(tui, theme.editor);
    editor.setAutocompleteProvider(autocomplete());
    editor.setText(text);
    editor.onSubmit = submit;
    showSlot();
    if (covering === undefined) tui.setFocus(editor);
  };
  const mountFooter = (): void => {
    if (mounted.footer === surface?.footer && footerSlot.children.length > 0) return;
    mounted.footer = surface?.footer;
    for (const dispose of disposers.splice(0)) dispose();
    footerSlot.clear();
    if (surface?.footer === undefined || options.footerData === undefined) { footerSlot.addChild(footer); return; }
    const drawn = surface.footer(tui, theme, options.footerData);
    if (drawn.dispose !== undefined) disposers.push(() => { drawn.dispose?.(); });
    footerSlot.addChild(drawn);
  };
  const mount = (): void => {
    mountHeader();
    mountEditor();
    mountFooter();
    loader.setIndicator(surface?.indicator);
    tui.requestRender();
  };

  const note = (text: string, tone: "muted" | "error" | "warning" = "muted"): void => {
    transcript.addChild(new Text(theme.fg(tone, text), 1, 1));
    tui.requestRender();
  };
  /**
   * While the gate verifies, the label names the work running and for how long (#590), from the shown session's
   * surface. The listener and the clock tick last only as long as the label does: a state without verification, a
   * session switch to another surface and the shell stopping all let go of them. A detail with a block also draws
   * it as the conversation's last block (#591), redrawn on the same changes and ticks, and gone when the label is.
   */
  let unwatchDetail: () => void = () => undefined;
  let watched: WorkingDetail | undefined;
  const drawBlock = (): void => {
    block.clear();
    const type = watched?.block;
    const drawn = type === undefined ? undefined
      : surface?.renderers.get(type)?.({ customType: type, content: "", details: watched }, { expanded, outputPad: 1 }, theme);
    if (drawn !== undefined) block.addChild(drawn);
  };
  const watchDetail = (settling: boolean): void => {
    const detail = settling ? surface?.detail : undefined;
    if (detail === watched) return;
    unwatchDetail();
    unwatchDetail = () => undefined;
    watched = detail;
    drawBlock();
    if (detail === undefined) return;
    const show = (): void => {
      loader.setMessage(verifyingLabel(detail.line(performance.now())));
      drawBlock();
      tui.requestRender();
    };
    const off = detail.subscribe(show);
    const tick = setInterval(show, 1000);
    unwatchDetail = () => { off(); clearInterval(tick); };
    show();
  };
  let retryTick: ReturnType<typeof setInterval> | undefined;
  const clearRetry = (): void => { clearInterval(retryTick); retryTick = undefined; };
  const retrying = (attempt: number, delayMs: number): void => {
    clearRetry();
    if (delayMs === 0) { loader.setMessage("Working…"); return; }
    const until = performance.now() + delayMs;
    const show = (): void => {
      loader.setMessage(`Retry ${attempt}/3 in ${Math.max(0, Math.ceil((until - performance.now()) / 1000))}s · Esc to cancel`);
      tui.requestRender();
    };
    retryTick = setInterval(show, 200);
    show();
  };
  const working = (state: "working" | "settling" | undefined): void => {
    clearRetry();
    status.clear();
    watchDetail(false);
    if (state === undefined) { loader.stop(); busy = false; } else {
      busy = true;
      loader.setMessage(state === "working" ? "Working…" : verifyingLabel());
      status.addChild(loader);
      loader.start();
      watchDetail(state === "settling");
    }
  };
  const restorePending = (): void => {
    const withdrawn = session.withdrawPendingMessages();
    if (withdrawn.length > 0) editor.setText([...withdrawn.map(({ text }) => text), editor.getText()].filter((text) => text.trim() !== "").join("\n\n"));
    tui.requestRender();
  };
  let replyError: string | undefined;
  const endedRun = (event: Extract<SessionEvent, { type: "ended" }>): void => {
    working(undefined);
    restorePending();
    if (event.outcome === "error" && event.reason !== undefined && event.reason !== replyError) note(providerError(event.reason), "error");
    if (session.awaiting() === undefined && event.outcome !== "completed") note(`The run ended ${event.outcome}.`, event.outcome === "aborted" ? "warning" : "error");
    drawFooter();
  };
  const onEvent = (event: SessionEvent): void => {
    if (event.type === "message" || event.type === "reply" || event.type === "call") {
      activity = true;
      mountedHeader?.emptyState?.pause();
    }
    if (event.type === "pending") drawPending();
    else if (event.type === "message") {
      transcript.add(event.message);
      if (event.message.role === "assistant") replyError = event.message.errorMessage;
    }
    else if (event.type === "reply") transcript.stream(event.partial);
    else if (event.type === "call") transcript.start(event.call);
    else if (event.type === "job") transcript.job(event.callId, event.details);
    else if (event.type === "state") { working(event.state); if (event.state === "working") replyError = undefined; }
    else if (event.type === "note") note(event.text, "warning");
    else if (event.type === "retry") retrying(event.attempt, event.delayMs);
    else if (event.type === "compacting") loader.setMessage("Compacting…");
    else if (event.type === "compacted") {
      loader.setMessage("Working…");
      note(`Compacted the conversation: about ${event.tokensBefore.toLocaleString("en")} tokens to ${event.tokensAfter.toLocaleString("en")}.`);
    } else endedRun(event);
    tui.requestRender();
  };
  let unsubscribe = session.subscribe(onEvent);

  // Typed text sent while idle answers a pending question and otherwise is a new request; a skill line is always a request.
  const send = (text: string, behavior?: "steer" | "followUp", request = false): void => {
    activity = true;
    mountedHeader?.emptyState?.pause();
    (behavior === undefined && !request ? session.reply(text) : session.prompt(text, behavior === undefined ? {} : { streamingBehavior: behavior })).catch((error: unknown) => {
      working(undefined);
      note(error instanceof Error ? error.message : String(error), "error");
    });
  };
  function submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    editor.setText("");
    if (trimmed.startsWith("/") && options.command !== undefined) {
      const word = trimmed.split(/\s/u)[0] ?? "";
      void options.command(trimmed).then((known) => {
        if (known) return;
        // A skill is a request, the line typed, whose text only the model reads; during a run it waits as a follow-up (#540).
        if (!session.skills().some(({ name }) => `/${name}` === word)) note(`No command ${word}.`, "warning");
        else send(trimmed, busy ? "followUp" : undefined, true);
      });
      return;
    }
    send(trimmed, busy ? "steer" : undefined);
  }
  mount();
  let unwatch = surface?.onChange(mount) ?? (() => undefined);
  // Tesota's theme for the terminal's own background, light or dark: when the terminal says, however late, and when it changes.
  let unfollow = (): void => undefined;
  if (surface !== undefined) {
    const appearance = (next: "light" | "dark"): void => {
      if (next === theme.appearance) return;
      theme.use(next);
      tui.invalidate();
      tui.requestRender(true);
    };
    const background = ({ background: color }: TerminalColors): void => {
      if (color !== undefined) appearance(0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b > 140 ? "light" : "dark");
    };
    void tui.queryTerminalColors({ timeoutMs: 200, onLateReply: background }).then(background).catch(() => undefined);
    unfollow = tui.onTerminalColorSchemeChange(appearance);
  }

  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let ending = false;
  const stop = (): void => {
    if (ending) return;
    ending = true;
    hideOverlay?.();
    // Each removes itself; a Set iterates on past what is deleted from it.
    for (const close of openPanels) close();
    for (const registrations of clarifications.values()) {
      for (const registration of registrations) registration.finish({ status: "cancelled", reason: "The shell stopped." });
    }
    clarifications.clear();
    visibleClarification = undefined;
    unsubscribe();
    clearRetry();
    unwatch();
    mountedHeader?.dispose?.();
    unfollow();
    watchDetail(false);
    for (const dispose of disposers.splice(0)) dispose();
    loader.stop();
    // Inline has no alternate buffer to discard: erase the live-only stage before leaving it behind.
    activity = true;
    if (tui instanceof TuiMainScreen) tui.renderNow();
    tui.stop({ preserveScreen: false });
    if (tui instanceof TuiAltScreen) {
      // The conversation stays in the terminal's scrollback, as the inline shell leaves it. Drawn without
      // starting the terminal again: a start queries it, and the reply would reach the prompt (#574).
      const scrollback = new TuiMainScreen(terminal);
      scrollback.addChild(document);
      scrollback.renderNow();
      terminal.showCursor();
    }
    resolveStopped();
  };
  /** When Ctrl+C last found the editor empty; a second press soon after ends the shell. */
  let interruptedAt = 0;
  const dashboardAvailable = (): boolean => covering === undefined || covering === visibleClarification?.mount?.question.body;
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (visibleClarification !== undefined) { void session.abort(); return { consume: true }; }
      if (editor.getText() !== "") editor.setText("");
      else if (Date.now() - interruptedAt < 1500) stop();
      else { interruptedAt = Date.now(); note("Press Ctrl+C again to end the shell."); }
      tui.requestRender();
      return { consume: true };
    }
    // Ctrl+T remains available while a clarification owns focus, so another live session can be selected (#520).
    if (matchesKey(data, "ctrl+t") && options.agents !== undefined && dashboardAvailable()) {
      options.agents(); return { consume: true };
    }
    // A dialog or the dashboard has the keyboard: Esc goes back there, and the shell's own keys wait (#455).
    if (covering !== undefined) return undefined;
    if (matchesKey(data, dequeueKey)) { restorePending(); return { consume: true }; }
    if (matchesKey(data, stopRunKey.key) && busy) { restorePending(); void session.abort(); return { consume: true }; }
    if (matchesKey(data, queueReplyKey.key)) {
      const text = editor.getText().trim();
      if (text !== "") { editor.setText(""); send(text, busy ? "followUp" : undefined); }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && editor.getText() === "") { stop(); return { consume: true }; }
    if (matchesKey(data, expandKey)) {
      expanded = !expanded;
      transcript.load(session.history());
      drawBlock();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab") && options.nextMode !== undefined) { options.nextMode(); return { consume: true }; }
    return undefined;
  });
  tui.start();

  /** A picker's, a prompt's or a permission's title, in the frame's style. */
  const heading = (title: string): Component => new Text(frameTitle(theme, title), 0, 0);

  /**
   * Shows `body` under `heading` in the input's place until `settle` is called,
   * as Pi and Claude Code ask: nothing is drawn over the conversation, and a
   * long command wraps in full above the choices. The editor, or the question
   * before it, comes back with the focus. It is framed (#531): `tone` says
   * whether it asks to approve something or to answer or choose.
   */
  function dialog<T>(heading: Component, body: Component & Focusable, wire: (settle: (value: T | undefined) => void) => void,
    tone: FrameTone = "answer"): Promise<T | undefined> {
    return new Promise((resolve) => {
      const inner = new Container();
      inner.addChild(heading);
      inner.addChild(body);
      const box = framed(theme, tone, inner);
      const question = { box, body };
      questions.push(question);
      showSlot();
      refocus();
      wire((value) => {
        questions.splice(questions.indexOf(question), 1);
        showSlot();
        refocus();
        tui.requestRender();
        resolve(value);
      });
      tui.requestRender();
    });
  }

  return {
    pick: (title, items) => {
      const list = new BandedList([...items], Math.min(items.length, 12), theme);
      return dialog<string>(heading(title), list, (settle) => {
        list.onSelect = (item) => { settle(item.value); };
        list.onCancel = () => { settle(undefined); };
      });
    },
    confirm: ({ title, body, note, items }) => {
      const list = new NumberedList(items.map((item, index) => ({ ...item, label: `${index + 1}. ${item.label}` })), items.length,
        theme);
      const top = new Container();
      top.addChild(heading(title));
      if (body !== undefined && body !== "") {
        top.addChild(new Spacer(1));
        top.addChild(new Text(theme.fg("dim", body), 2, 0));
      }
      top.addChild(new Spacer(1));
      if (note !== undefined) top.addChild(new Text(theme.fg("muted", note), 0, 0));
      return dialog<string>(top, list, (settle) => {
        list.onSelect = (item) => { settle(item.value); };
        list.onCancel = () => { settle(undefined); };
      }, "approve");
    },
    ask: (message, askOptions = {}) => {
      const input = askOptions.secret === true ? new SecretInput()
        : new Input(askOptions.placeholder === undefined ? {} : { placeholder: askOptions.placeholder });
      return dialog<string>(heading(message), input, (settle) => {
        input.onSubmit = (value) => { settle(value); };
        input.onEscape = () => { settle(undefined); };
      });
    },
    show(next, nextSurface, state) {
      detachClarification();
      unsubscribe();
      drafts.set(session, editor.getText());
      session = next;
      activity = session.history().length > 0;
      editor.setAutocompleteProvider(autocomplete());
      unsubscribe = session.subscribe(onEvent);
      if (nextSurface !== undefined && nextSurface !== surface) {
        unwatch();
        surface = nextSurface;
        mounted = {};
        unwatch = surface.onChange(mount);
        mount();
      }
      editor.setText(drafts.get(next) ?? "");
      drafts.delete(next);
      transcript.load(session.history());
      drawPending();
      working(state);
      drawFooter();
      mountClarificationsFor(next);
      tui.requestRender();
    },
    overlay(body) {
      if (ending) { body.dispose?.(); return () => undefined; }
      hideOverlay?.();
      const handle = tui.showOverlay(body, { width: "100%", maxHeight: "100%", anchor: "center" });
      overlayBody = body;
      covering = body;
      tui.setFocus(body);
      tui.requestRender();
      const hide = (): void => {
        body.dispose?.();
        handle.hide();
        if (overlayBody !== body) return;
        overlayBody = undefined;
        hideOverlay = undefined;
        if (ending) return;
        // A question that waited in the input's place, or came while the overlay was up, gets the keyboard; the editor otherwise.
        covering = questions.at(-1)?.body;
        mountClarificationsFor(session);
        tui.setFocus(covering ?? editor);
        tui.requestRender();
      };
      hideOverlay = hide;
      return hide;
    },
    panel(title, body) {
      if (ending) { body.dispose?.(); return () => undefined; }
      let close = (): void => undefined;
      void dialog<undefined>(heading(title), body, (settle) => {
        close = () => {
          if (!openPanels.delete(close)) return;
          body.dispose?.();
          settle(undefined);
        };
        openPanels.add(close);
      });
      return () => { close(); };
    },
    askUser(owner, asked, submitAnswer, finish) {
      const registration: ClarificationRegistration = { owner, questions: asked, submit: submitAnswer, draft: createQuestionDraft(asked), finish, mount: undefined,
        released: false, generation: 0 };
      const registrations = clarifications.get(owner) ?? new Set<ClarificationRegistration>();
      registrations.add(registration);
      clarifications.set(owner, registrations);
      mountClarification(registration);
      return () => {
        if (registration.released) return;
        registration.released = true;
        if (visibleClarification === registration) {
          detachClarification();
          refocus();
        }
        const registrations = clarifications.get(owner);
        registrations?.delete(registration);
        if (registrations?.size === 0) clarifications.delete(owner);
        if (!ending) tui.requestRender();
      };
    },
    cancelQuestions(owner, reason) {
      for (const registration of clarifications.get(owner) ?? []) registration.finish({ status: "cancelled", reason });
    },
    busy: (state) => { working(state); tui.requestRender(); },
    note,
    redraw: () => { drawFooter(); tui.requestRender(); },
    handOver: async (work) => {
      handedOver = true;
      mountedHeader?.emptyState?.pause();
      if (tui instanceof TuiMainScreen) tui.renderNow();
      tui.stop();
      // Ctrl+C reaches every process on the terminal: it is the other program's to cancel with, and must not end the shell.
      const keep = (): void => undefined;
      process.on("SIGINT", keep);
      try { return await work(); } finally {
        process.off("SIGINT", keep);
        handedOver = false;
        tui.start();
        tui.requestRender(true);
      }
    },
    stop,
    stopped,
  };
}
