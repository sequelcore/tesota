import {
  type Component, Container, Editor, type Focusable, Input, Loader, matchesKey, ScrollView, type SelectItem, SelectList, type Terminal, Text,
  TuiAltScreen, type TuiAltScreenOptions, TuiMainScreen, VStack,
} from "@earendil-works/pi-tui";
import type { SessionEvent } from "../loop.ts";
import type { EngineSession } from "../session.ts";
import type { TuiMode } from "../settings.ts";
import { copyToClipboard } from "./clipboard.ts";
import type { ShellTheme } from "./theme.ts";
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
  /** Shows `session` instead, its conversation drawn from its history. */
  show(session: EngineSession): void;
  /** Writes a line of the shell's own into the conversation. */
  note(text: string, tone?: "muted" | "error" | "warning"): void;
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
 * Alt+Enter queues a follow-up; Esc stops the run; Ctrl+D on an empty editor
 * ends the shell. On ending, a fullscreen shell writes the conversation to
 * the scrollback, as Pi does.
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

  const document = new Container();
  const transcript = new Transcript(theme);
  document.addChild(new Text(theme.fg("dim", `tesota-core · ${process.cwd()}`), 1, 1));
  document.addChild(transcript);
  const status = new Container();
  const loader = new Loader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "Working…");
  const editor = new Editor(tui, theme.editor);
  const footer = new Text("", 1, 0);
  const drawFooter = (): void => { footer.setText(theme.fg("dim", options.status())); };
  drawFooter();
  const dock: readonly Component[] = [status, editor, footer];
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
  tui.setFocus(editor);

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
    else {
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
  editor.onSubmit = (text) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    editor.setText("");
    if (trimmed.startsWith("/") && options.command !== undefined) {
      void options.command(trimmed).then((known) => { if (!known) note(`No command ${trimmed.split(/\s/u)[0]}.`, "warning"); });
      return;
    }
    send(trimmed, busy ? "steer" : undefined);
  };

  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  let ending = false;
  const stop = (): void => {
    if (ending) return;
    ending = true;
    unsubscribe();
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
  tui.addInputListener((data) => {
    if (matchesKey(data, "escape") && busy) { void session.abort(); return { consume: true }; }
    if (matchesKey(data, "alt+enter")) {
      const text = editor.getText().trim();
      if (text !== "") { editor.setText(""); send(text, busy ? "followUp" : undefined); }
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+d") && editor.getText() === "") { stop(); return { consume: true }; }
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
      tui.setFocus(body);
      wire((value) => {
        handle.hide();
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
    show(next) {
      unsubscribe();
      session = next;
      unsubscribe = session.subscribe(onEvent);
      transcript.load(session.history());
      working(undefined);
      drawFooter();
      tui.requestRender();
    },
    note,
    stop,
    stopped,
  };
}
