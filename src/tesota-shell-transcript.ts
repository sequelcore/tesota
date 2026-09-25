import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, type Component,
  type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentActivity } from "./integrations/pi-coding-session.js";
import { backgroundText, bold, colorText, mutedText, type TesotaShellTheme } from "./tesota-shell-theme.js";

export type NoticeTone = "info" | "warning" | "success";

/** One recorded item of a session's conversation, as the store keeps it. */
export type TranscriptEntry =
  | Readonly<{ kind: "user"; text: string }>
  | Readonly<{ kind: "agent"; text: string }>
  | Readonly<{ kind: "notice"; text: string; tone: NoticeTone }>
  | Readonly<{ kind: "tool"; tool: string; subject: string; failed: boolean }>
  | Readonly<{ kind: "review"; title: string; text: string }>;

/** Escape control characters so recorded or model text cannot drive the terminal. */
export function safeTerminalText(text: string): string {
  let safe = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    safe += code <= 8 || code >= 11 && code <= 31 || code >= 127 && code <= 159 ?
      `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return safe;
}

export function markdownTheme(theme: TesotaShellTheme): MarkdownTheme {
  const accent = (text: string): string => colorText(text, theme.accent);
  const muted = (text: string): string => mutedText(text, theme);
  return {
    heading: (text) => bold(accent(text)),
    link: (text) => `\x1b[4m${accent(text)}\x1b[24m`,
    linkUrl: muted,
    code: accent,
    codeBlock: (text) => text,
    codeBlockBorder: muted,
    quote: (text) => `\x1b[3m${muted(text)}\x1b[23m`,
    quoteBorder: muted,
    hr: muted,
    listBullet: accent,
    bold,
    italic: (text) => `\x1b[3m${text}\x1b[23m`,
    strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
    underline: (text) => `\x1b[4m${text}\x1b[24m`,
    ...(theme.accent === null ? {} : { highlightCode: (code: string, lang?: string) => highlightCode(code, lang) }),
  };
}

const toolNames: Readonly<Record<string, string>> = { bash: "Run", read: "Read", edit: "Edit", write: "Write",
  grep: "Search", find: "Find", ls: "List" };
/** Output lines kept under a command, as Claude Code and Codex show a command's tail. */
const outputTail = 4;

/** One tool call: a status mark, its name and subject, and for commands or failures the end of its output. */
class ToolBlock implements Component {
  #state: "running" | "done" | "failed" | "stopped" = "running";
  #output = "";

  private readonly theme: TesotaShellTheme;
  readonly tool: string;
  readonly subject: string;

  constructor(theme: TesotaShellTheme, tool: string, subject: string) {
    this.theme = theme;
    this.tool = tool;
    this.subject = subject;
  }

  update(output: string): void { this.#output = output; }
  finish(failed: boolean, output: string): void { this.#state = failed ? "failed" : "done"; this.#output = output; }
  stop(): void { if (this.#state === "running") this.#state = "stopped"; }

  invalidate(): void {}

  render(width: number): string[] {
    const color = this.#state === "failed" ? this.theme.error : this.#state === "done" ? this.theme.success :
      this.#state === "stopped" ? this.theme.warning : this.theme.accent;
    const name = toolNames[this.tool] ?? this.tool;
    const head = ` ${colorText("●", color)} ${bold(name)} ${mutedText(safeTerminalText(this.subject), this.theme)}` +
      (this.#state === "stopped" ? mutedText(" (stopped)", this.theme) : "");
    const lines = [truncateToWidth(head, width)];
    if (this.tool !== "bash" && this.#state !== "failed") return lines;
    const output = safeTerminalText(this.#output.trimEnd()).split(/\r?\n/u).filter((line) => line.length > 0);
    const shown = output.slice(-outputTail);
    if (output.length > shown.length) lines.push(truncateToWidth(mutedText(`   ⎿ … ${output.length - shown.length} earlier lines`, this.theme), width));
    for (const [index, line] of shown.entries()) {
      const prefix = index === 0 && output.length === shown.length ? "   ⎿ " : "     ";
      lines.push(truncateToWidth(mutedText(`${prefix}${line}`, this.theme), width));
    }
    return lines;
  }
}

function reviewLine(line: string, theme: TesotaShellTheme): string {
  if (/^\s*✓/u.test(line)) return colorText(line, theme.success);
  if (/^\s*✗/u.test(line)) return colorText(line, theme.error);
  return line;
}

/**
 * A session's conversation as components: the operator's messages on their
 * own background, the agent's replies as Markdown that grows while it
 * streams, tool calls as status lines, and Tesota's notices muted.
 */
export class Transcript {
  readonly container: Container = new Container();
  readonly #theme: TesotaShellTheme;
  readonly #markdown: MarkdownTheme;
  readonly #replies = new Map<number, Markdown>();
  readonly #tools = new Map<string, ToolBlock>();
  #last = "";

  constructor(theme: TesotaShellTheme) {
    this.#theme = theme;
    this.#markdown = markdownTheme(theme);
  }

  /** The plain text of the latest agent reply or notice, to leave on screen when the shell exits. */
  get lastMessage(): string { return this.#last; }

  add(entry: TranscriptEntry): void {
    this.#append(this.#render(entry));
    if (entry.kind === "agent" || entry.kind === "notice") this.#last = safeTerminalText(entry.text);
  }

  /** Show agent activity; returns the entry to record once a reply or tool call is complete. */
  activity(activity: AgentActivity): TranscriptEntry | undefined {
    switch (activity.type) {
      case "reply": return this.#reply(activity.message, activity.text, activity.final);
      case "tool_started": {
        const block = new ToolBlock(this.#theme, activity.tool, activity.subject);
        this.#tools.set(activity.call, block);
        this.#append(block);
        return undefined;
      }
      case "tool_output":
        this.#tools.get(activity.call)?.update(activity.output);
        return undefined;
      case "tool_finished": {
        const block = this.#tools.get(activity.call);
        if (block === undefined) return undefined;
        block.finish(activity.failed, activity.output);
        this.#tools.delete(activity.call);
        return { kind: "tool", tool: block.tool, subject: block.subject, failed: activity.failed };
      }
    }
  }

  /** End the turn: tool calls still shown as running were stopped with it. */
  settle(): void {
    for (const block of this.#tools.values()) block.stop();
    this.#tools.clear();
    this.#replies.clear();
  }

  #reply(message: number, text: string, final: boolean): TranscriptEntry | undefined {
    let component = this.#replies.get(message);
    if (component === undefined && text.length > 0) {
      component = new Markdown("", 1, 0, this.#markdown);
      this.#replies.set(message, component);
      this.#append(component);
    }
    component?.setText(safeTerminalText(text));
    if (!final) return undefined;
    this.#replies.delete(message);
    if (text.length === 0) return undefined;
    this.#last = safeTerminalText(text);
    return { kind: "agent", text };
  }

  #render(entry: TranscriptEntry): Component {
    const theme = this.#theme;
    switch (entry.kind) {
      case "user": {
        if (theme.userBackground === null) return new Text(`${bold("›")} ${safeTerminalText(entry.text)}`, 1, 0);
        const box = new Box(1, 1, (line) => backgroundText(line, theme.userBackground));
        box.addChild(new Text(safeTerminalText(entry.text), 0, 0));
        return box;
      }
      case "agent": return new Markdown(safeTerminalText(entry.text), 1, 0, this.#markdown);
      case "notice": {
        const text = safeTerminalText(entry.text);
        return new Text(entry.tone === "warning" ? colorText(text, theme.warning) :
          entry.tone === "success" ? colorText(text, theme.success) : mutedText(text, theme), 1, 0);
      }
      case "tool": {
        const block = new ToolBlock(theme, entry.tool, entry.subject);
        block.finish(entry.failed, "");
        return block;
      }
      case "review": {
        const body = safeTerminalText(entry.text).split("\n").map((line) => reviewLine(line, theme)).join("\n");
        return new Text(`${bold(colorText(safeTerminalText(entry.title), theme.accent))}\n${body}\n` +
          mutedText("Alt+R shows or hides the full diff and check output.", theme), 1, 0);
      }
    }
  }

  #append(component: Component): void {
    // Consecutive tool calls read as one group; everything else is separated by a blank line.
    const previous = this.container.children.at(-1);
    if (previous !== undefined && !(previous instanceof ToolBlock && component instanceof ToolBlock)) {
      this.container.addChild(new Spacer(1));
    }
    this.container.addChild(component);
    this.container.invalidate();
  }
}
