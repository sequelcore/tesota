import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component,
  type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentActivity, AgentChange } from "./integrations/model-session-contract.js";
import { backgroundText, bold, colorText, mutedText, type TesotaShellTheme } from "./tesota-shell-theme.js";

export type NoticeTone = "info" | "warning" | "success";

/** One recorded item of a session's conversation, as the store keeps it. */
export type TranscriptEntry =
  | Readonly<{ kind: "user"; text: string }>
  | Readonly<{ kind: "agent"; text: string }>
  | Readonly<{ kind: "notice"; text: string; tone: NoticeTone }>
  | Readonly<{ kind: "tool"; tool: string; subject: string; failed: boolean; change?: AgentChange | undefined }>
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

function markdownTheme(theme: TesotaShellTheme): MarkdownTheme {
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

const toolNames: Readonly<Record<string, string>> = { bash: "Run", powershell: "Run", read: "Read", edit: "Edit", write: "Write",
  grep: "Search", find: "Find", ls: "List", web_search: "Web search", web_read: "Read page", web_fetch: "Fetch page",
  advisor: "Advisor" };
/** Output lines kept under a command, as Claude Code and Codex show a command's tail. */
const outputTail = 4;

/** One tool call: a status mark, its name and subject, and for commands or failures the end of its output. */
class ToolBlock implements Component {
  #state: "running" | "done" | "failed" | "stopped" = "running";
  #output = "";
  #change: AgentChange | undefined;

  private readonly theme: TesotaShellTheme;
  readonly tool: string;
  readonly subject: string;

  constructor(theme: TesotaShellTheme, tool: string, subject: string) {
    this.theme = theme;
    this.tool = tool;
    this.subject = subject;
  }

  /** The lines last drawn and their width: a finished call no longer changes, and every frame asks for it again. */
  #cached: { width: number; lines: string[] } | undefined;

  update(output: string): void { this.#output = output; this.#cached = undefined; }
  finish(failed: boolean, output: string, change?: AgentChange): void {
    this.#state = failed ? "failed" : "done";
    this.#output = output;
    this.#change = failed ? undefined : change;
    this.#cached = undefined;
  }
  stop(): void {
    if (this.#state === "running") this.#state = "stopped";
    this.#cached = undefined;
  }

  invalidate(): void { this.#cached = undefined; }

  render(width: number): string[] {
    if (this.#cached?.width === width) return this.#cached.lines;
    const lines = this.#lines(width);
    this.#cached = { width, lines };
    return lines;
  }

  #lines(width: number): string[] {
    const color = this.#state === "failed" ? this.theme.error : this.#state === "done" ? this.theme.success :
      this.#state === "stopped" ? this.theme.warning : this.theme.accent;
    const name = toolNames[this.tool] ?? this.tool;
    const counts = this.#change === undefined ? "" : ` (+${this.#change.added} −${this.#change.removed})`;
    const lead = ` ${colorText("•", color)} ${bold(name)} `;
    const tail = colorText(counts, this.theme.success) + (this.#state === "stopped" ? mutedText(" (stopped)", this.theme) : "");
    const subject = mutedText(safeTerminalText(this.subject), this.theme);
    // A command is shown whole, its continuation under its first word; any other subject, a path, fits one row.
    const indent = visibleWidth(lead);
    const lines = this.tool === "bash" && width > indent + 10
      ? wrapTextWithAnsi(subject + tail, width - indent).map((row, index) => `${index === 0 ? lead : " ".repeat(indent)}${row}`)
      : [truncateToWidth(lead + subject + tail, width)];
    if (this.#change !== undefined) {
      for (const line of this.#change.lines) {
        const color = line.startsWith("+") ? this.theme.success : line.startsWith("-") ? this.theme.error : this.theme.accent;
        lines.push(truncateToWidth(`   ${colorText(safeTerminalText(line), color)}`, width));
      }
      return lines;
    }
    if (this.tool !== "bash" && this.#state !== "failed") return lines;
    const output = safeTerminalText(this.#output.trimEnd()).split(/\r?\n/u).filter((line) => line.length > 0);
    const shown = output.slice(-outputTail);
    if (output.length > shown.length) lines.push(truncateToWidth(mutedText(`   └ … ${output.length - shown.length} earlier lines`, this.theme), width));
    for (const [index, line] of shown.entries()) {
      const prefix = index === 0 && output.length === shown.length ? "   └ " : "     ";
      lines.push(truncateToWidth(mutedText(`${prefix}${line}`, this.theme), width));
    }
    return lines;
  }
}

function reviewLine(line: string, theme: TesotaShellTheme): string {
  if (/^\s*✓/u.test(line)) return colorText(line, theme.success);
  if (/^\s*✗/u.test(line)) return colorText(line, theme.error);
  if (/^\s*⚠/u.test(line)) return colorText(line, theme.warning);
  return line;
}

/** Keep routine multi-line notices readable without losing their recorded detail. */
class ExpandableNotice implements Component {
  #expanded = false;
  readonly #text: string;
  readonly #theme: TesotaShellTheme;
  constructor(text: string, theme: TesotaShellTheme) { this.#text = safeTerminalText(text); this.#theme = theme; }
  get preview(): string {
    const lines = this.#text.split("\n");
    const heading = (lines[0] ?? "Notice").replace(/ from your repository into the workspace:$/u, "")
      .replace(/:$/u, "");
    return `${truncateToWidth(heading, 42)} · ${lines.length - 1} lines hidden · Alt+D /details`;
  }
  #shown: Text | undefined;
  toggle(): void { this.#expanded = !this.#expanded; this.#shown = undefined; }
  invalidate(): void { this.#shown = undefined; }
  render(width: number): string[] {
    const text = this.#expanded ? `${this.#text}\nAlt+D or /details to collapse` : this.preview;
    this.#shown ??= new Text(mutedText(text, this.#theme), 1, 0);
    return this.#shown.render(width);
  }
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
  readonly #notices: ExpandableNotice[] = [];
  #last = "";

  constructor(theme: TesotaShellTheme) {
    this.#theme = theme;
    this.#markdown = markdownTheme(theme);
  }

  /** The plain text of the latest agent reply or notice, to leave on screen when the shell exits. */
  get lastMessage(): string { return this.#last; }

  add(entry: TranscriptEntry): void {
    const component = this.#render(entry);
    this.#append(component);
    if (component instanceof ExpandableNotice) this.#notices.push(component);
    if (entry.kind === "agent" || entry.kind === "notice") {
      this.#last = component instanceof ExpandableNotice ? component.preview : safeTerminalText(entry.text);
    }
  }

  /** Toggle one recorded long notice, counting back from the latest. */
  toggleNotice(index = 0): boolean {
    const notice = this.#notices.at(-1 - index);
    if (notice === undefined) return false;
    notice.toggle();
    return true;
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
        block.finish(activity.failed, activity.output, activity.change);
        this.#tools.delete(activity.call);
        return { kind: "tool", tool: block.tool, subject: block.subject, failed: activity.failed,
          ...(activity.change === undefined ? {} : { change: activity.change }) };
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
        if (entry.tone === "info" && entry.text.split("\n").length > 4) {
          return new ExpandableNotice(entry.text, theme);
        }
        const text = safeTerminalText(entry.text);
        return new Text(entry.tone === "warning" ? colorText(text, theme.warning) :
          entry.tone === "success" ? colorText(text, theme.success) : mutedText(text, theme), 1, 0);
      }
      case "tool": {
        const block = new ToolBlock(theme, entry.tool, entry.subject);
        block.finish(entry.failed, "", entry.change);
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
    // pi-tui's Container.invalidate() clears every child's cache; a new entry needs none cleared.
    this.container.addChild(component);
  }
}
