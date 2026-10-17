import {
  type Component, Container, Editor, type Focusable, Input, Loader, matchesKey, ScrollView, type SelectItem, SelectList,
  type Terminal, type TerminalColors, Text, TuiAltScreen, type TuiAltScreenOptions, TuiMainScreen, VStack,
} from "@earendil-works/pi-tui";
import type { FooterData } from "../../../../src/contract.ts";
import type { SessionEvent } from "../loop.ts";
import type { EngineSession } from "../session.ts";
import type { TuiMode } from "../settings.ts";
import { copyToClipboard } from "./clipboard.ts";
import { expandKey, type Surface } from "./surface.ts";
import type { ShellTheme } from "../../../../src/theme.ts";
import { Transcript } from "./transcript.ts";

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

/** A running shell: what it draws, and how it ends. */
export interface Shell {
  /** Asks the operator to choose one of `items`; undefined when they cancel. */
  pick(title: string, items: readonly SelectItem[]): Promise<string | undefined>;
  /** Asks the operator for a line of text, hidden when `secret`; undefined when they cancel. */
  ask(message: string, options?: { readonly secret?: boolean; readonly placeholder?: string }): Promise<string | undefined>;
  /**
   * Shows `session` instead, its conversation drawn from its history (#455):
   * with its own surface when it has one, so its header, editor and footer
   * are its own, and as working or verifying when its run is going.
   */
  show(session: EngineSession, surface?: Surface, state?: "working" | "settling"): void;
  /** Shows `body` over the whole shell with the keyboard's focus; the returned function takes it away again. */
  overlay(body: Component): () => void;
  /** Shows the shown session's run as working, verifying or idle, when it goes on without saying so (#455). */
  busy(state: "working" | "settling" | undefined): void;
  /** Writes a line of the shell's own into the conversation. */
  note(text: string, tone?: "muted" | "error" | "warning"): void;
  /** Draws the footer again, as `status` now says it. */
  redraw(): void;
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
  const header = new Container();
  document.addChild(header);
  document.addChild(transcript);
  const status = new Container();
  const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "Working…");
  const editorSlot = new Container();
  let editor = new Editor(tui, theme.editor);
  const footerSlot = new Container();
  const footer = new Text("", 1, 0);
  const drawFooter = (): void => { footer.setText(theme.fg("dim", options.status())); };
  drawFooter();
  const dock: readonly Component[] = [status, editorSlot, footerSlot];
  if (tui instanceof TuiAltScreen) {
    tui.setLayoutRoot(new VStack([
      { component: new ScrollView(document, { follow: "end", primary: true, overscroll: "chain" }), basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: new VStack(dock.map((component) => ({ component, shrink: 1, minSize: 0 }))), basis: "auto", grow: 0, shrink: 1,
        minSize: 1 },
    ]));
  } else {
    tui.addChild(document);
    for (const component of dock) tui.addChild(component);
  }

  /** What has the keyboard over the shell, a dialog or the dashboard (#455): the editor takes it back only when nothing does. */
  let covering: Component | undefined;
  /** Each session's unsent text, kept while another is shown (#455). */
  const drafts = new Map<EngineSession, string>();
  /** What each slot was last built from, so a change rebuilds only what changed and the editor keeps its text otherwise. */
  let mounted: { header?: unknown; editor?: unknown; footer?: unknown } = {};
  let disposers: (() => void)[] = [];
  const mountHeader = (): void => {
    if (mounted.header === surface?.header && header.children.length > 0) return;
    mounted.header = surface?.header;
    header.clear();
    header.addChild(surface?.header === undefined ? new Text(theme.fg("dim", `tesota-core · ${session.workspace.cwd}`), 1, 1)
      : surface.header(tui, theme));
  };
  const mountEditor = (): void => {
    if (mounted.editor === surface?.editor && editorSlot.children.length > 0) return;
    mounted.editor = surface?.editor;
    const text = editor.getText();
    editor = surface?.editor === undefined ? new Editor(tui, theme.editor)
      : surface.editor(tui, theme.editor);
    editor.setText(text);
    editor.onSubmit = submit;
    editorSlot.clear();
    editorSlot.addChild(editor);
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
  const working = (state: "working" | "settling" | undefined): void => {
    status.clear();
    if (state === undefined) { loader.stop(); busy = false; } else {
      busy = true;
      loader.setMessage(state === "working" ? "Working…" : "Verifying…");
      status.addChild(loader);
      loader.start();
    }
  };
  const onEvent = (event: SessionEvent): void => {
    if (event.type === "message") transcript.add(event.message);
    else if (event.type === "reply") transcript.stream(event.partial);
    else if (event.type === "call") transcript.start(event.call);
    else if (event.type === "state") working(event.state);
    else if (event.type === "note") note(event.text, "warning");
    else if (event.type === "compacting") loader.setMessage("Compacting…");
    else if (event.type === "compacted") {
      loader.setMessage("Working…");
      note(`Compacted the conversation: about ${event.tokensBefore.toLocaleString("en")} tokens to ${event.tokensAfter.toLocaleString("en")}.`);
    } else {
      working(undefined);
      if (event.outcome !== "completed") note(`The run ended ${event.outcome}.`, event.outcome === "aborted" ? "warning" : "error");
      drawFooter();
    }
    tui.requestRender();
  };
  let unsubscribe = session.subscribe(onEvent);

  const send = (text: string, behavior?: "steer" | "followUp"): void => {
    session.prompt(text, behavior === undefined ? {} : { streamingBehavior: behavior }).catch((error: unknown) => {
      working(undefined);
      note(error instanceof Error ? error.message : String(error), "error");
    });
  };
  function submit(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") return;
    editor.setText("");
    if (trimmed.startsWith("/") && options.command !== undefined) {
      void options.command(trimmed).then((known) => { if (!known) note(`No command ${trimmed.split(/\s/u)[0]}.`, "warning"); });
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
    unsubscribe();
    unwatch();
    unfollow();
    for (const dispose of disposers.splice(0)) dispose();
    loader.stop();
    tui.stop({ preserveScreen: false });
    if (tui instanceof TuiAltScreen) {
      // The conversation stays in the terminal's scrollback, as the inline shell leaves it.
      const scrollback = new TuiMainScreen(terminal);
      scrollback.addChild(document);
      scrollback.start();
      scrollback.renderNow();
      scrollback.stop({ preserveScreen: true });
    }
    resolveStopped();
  };
  /** When Ctrl+C last found the editor empty; a second press soon after ends the shell. */
  let interruptedAt = 0;
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      if (editor.getText() !== "") editor.setText("");
      else if (Date.now() - interruptedAt < 1500) stop();
      else { interruptedAt = Date.now(); note("Press Ctrl+C again to end the shell."); }
      tui.requestRender();
      return { consume: true };
    }
    // A dialog or the dashboard has the keyboard: Esc goes back there, and the shell's own keys wait (#455).
    if (covering !== undefined) return undefined;
    if (matchesKey(data, "escape") && busy) { void session.abort(); return { consume: true }; }
    if (matchesKey(data, "alt+enter")) {
      const text = editor.getText().trim();
      if (text !== "") { editor.setText(""); send(text, busy ? "followUp" : undefined); }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && editor.getText() === "") { stop(); return { consume: true }; }
    if (matchesKey(data, expandKey)) {
      expanded = !expanded;
      transcript.load(session.history());
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "shift+tab") && options.nextMode !== undefined) { options.nextMode(); return { consume: true }; }
    if (matchesKey(data, "ctrl+t") && options.agents !== undefined) { options.agents(); return { consume: true }; }
    return undefined;
  });
  tui.start();

  /** Shows `body` under `title` over the shell until `settle` is called, then gives the editor back its focus. */
  function dialog<T>(title: string, body: Component & Focusable, wire: (settle: (value: T | undefined) => void) => void): Promise<T | undefined> {
    return new Promise((resolve) => {
      const box = new Container();
      box.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
      box.addChild(body);
      const handle = tui.showOverlay(box, { width: "80%", maxHeight: "60%", anchor: "center" });
      covering = body;
      tui.setFocus(body);
      wire((value) => {
        handle.hide();
        covering = undefined;
        tui.setFocus(editor);
        tui.requestRender();
        resolve(value);
      });
      tui.requestRender();
    });
  }

  return {
    pick: (title, items) => {
      const list = new SelectList([...items], Math.min(items.length, 12), theme.selectList);
      return dialog<string>(title, list as SelectList & Focusable, (settle) => {
        list.onSelect = (item) => { settle(item.value); };
        list.onCancel = () => { settle(undefined); };
      });
    },
    ask: (message, askOptions = {}) => {
      const input = askOptions.secret === true ? new SecretInput()
        : new Input(askOptions.placeholder === undefined ? {} : { placeholder: askOptions.placeholder });
      return dialog<string>(message, input, (settle) => {
        input.onSubmit = (value) => { settle(value); };
        input.onEscape = () => { settle(undefined); };
      });
    },
    show(next, nextSurface, state) {
      unsubscribe();
      drafts.set(session, editor.getText());
      session = next;
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
      working(state);
      drawFooter();
      tui.requestRender();
    },
    overlay(body) {
      const handle = tui.showOverlay(body, { width: "100%", maxHeight: "100%", anchor: "center" });
      covering = body;
      tui.setFocus(body);
      tui.requestRender();
      return () => {
        handle.hide();
        covering = undefined;
        tui.setFocus(editor);
        tui.requestRender();
      };
    },
    busy: (state) => { working(state); tui.requestRender(); },
    note,
    redraw: () => { drawFooter(); tui.requestRender(); },
    stop,
    stopped,
  };
}
