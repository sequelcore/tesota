import { highlightCode } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component,
  type MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentActivity, AgentChange } from "./integrations/model-session-contract.js";
import { terminalOutputText } from "./terminal-output.js";
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
    highlightCode: (code: string, lang?: string) => theme.accent === null ? code.split("\n") : highlightCode(code, lang),
  };
}

const toolNames: Readonly<Record<string, string>> = { bash: "Run", read: "Read", edit: "Edit", write: "Write",
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
    const output = safeTerminalText(terminalOutputText(this.#output.trimEnd())).split("\n").filter((line) => line.length > 0);
    const shown = output.slice(-outputTail);
    if (output.length > shown.length) lines.push(truncateToWidth(mutedText(`   └ … ${output.length - shown.length} earlier lines`, this.theme), width));
    for (const [index, line] of shown.entries()) {
      const prefix = index === 0 && output.length === shown.length ? "   └ " : "     ";
      lines.push(truncateToWidth(mutedText(`${prefix}${line}`, this.theme), width));
    }
    return lines;
  }
}

/**
 * The part of a record line that its wrapped rows continue under: the indent, then a mark, the output gutter or a list
 * number. Records saved before "!" replaced "⚠" keep theirs, drawn as "!".
 */
const recordLead = /^ *(?:[✓✗!⚠?·│] |\d+\. )?/u;
const recordLabel = /^(?:Claim|Limits|Origin|Refuter):/u;

/**
 * Style one record line by its shape: an unindented line is a section heading
 * in the result panel and a note in the conversation, a mark gives its color,
 * command output and settled context recede, and field labels are muted.
 */
function paintRecordLine(lead: string, body: string, theme: TesotaShellTheme, headings: boolean): readonly [string, string] {
  const all = (paint: (text: string) => string): readonly [string, string] => [paint(lead), paint(body)];
  if (lead.length === 0) return body.length === 0 ? ["", ""] : all(headings ? (text) => bold(colorText(text, theme.accent))
    : (text) => mutedText(text, theme));
  switch (lead.trim()[0]) {
    case "✓": return all((text) => colorText(text, theme.success));
    case "✗": return all((text) => colorText(text, theme.error));
    case "!": case "?": return all((text) => colorText(text, theme.warning));
    case "·": case "│": return all((text) => mutedText(text, theme));
  }
  const label = recordLabel.exec(body)?.[0];
  return label === undefined ? [lead, body] : [lead, mutedText(label, theme) + body.slice(label.length)];
}

/**
 * A review record's text as rows of at most `width` columns, each wrapped row
 * continuing under its line's text so nesting stays visible in a narrow
 * panel. With `headings`, unindented lines are drawn as section headings.
 */
export function recordRows(text: string, width: number, theme: TesotaShellTheme, headings: boolean): string[] {
  return safeTerminalText(text).split("\n").flatMap((line) => {
    const saved = recordLead.exec(line)?.[0] ?? "";
    const lead = saved.replace("⚠", "!");
    const [paintedLead, body] = paintRecordLine(lead, line.slice(saved.length), theme, headings);
    const indent = visibleWidth(lead);
    if (width - indent < 16) return wrapTextWithAnsi(paintedLead + body, Math.max(1, width));
    // Command output keeps its gutter on every row, so a long output line never reads as part of the record.
    const continuation = lead.includes("│") ? paintedLead : " ".repeat(indent);
    return wrapTextWithAnsi(body, width - indent).map((row, index) => (index === 0 ? paintedLead : continuation) + row);
  });
}

/**
 * A review in the conversation: a colored rule down its left side sets it
 * apart from the agent's replies, which are Markdown with headings of their own.
 */
class ReviewBlock implements Component {
  readonly #title: string;
  readonly #text: string;
  readonly #theme: TesotaShellTheme;
  /** The key to the full record, when it is useful: under the latest review only, while the record is not shown. */
  readonly #hint: () => string | undefined;
  #cached: { width: number; hint: string | undefined; lines: string[] } | undefined;
  constructor(title: string, text: string, theme: TesotaShellTheme, hint: () => string | undefined) {
    this.#title = title;
    this.#text = text;
    this.#theme = theme;
    this.#hint = hint;
  }
  invalidate(): void { this.#cached = undefined; }
  render(width: number): string[] {
    const hint = this.#hint();
    if (this.#cached?.width === width && this.#cached.hint === hint) return this.#cached.lines;
    const theme = this.#theme;
    const rule = ` ${colorText("┃", theme.accent)} `;
    const inner = Math.max(1, width - visibleWidth(rule));
    const lines = [...wrapTextWithAnsi(bold(colorText(safeTerminalText(this.#title), theme.accent)), inner),
      ...recordRows(hint === undefined ? this.#text : `${this.#text}\n${hint}`, inner, theme, false)]
      .map((row) => rule + row);
    this.#cached = { width, hint, lines };
    return lines;
  }
}

/** The latest review's key to its full record, while the result panel is hidden. */
const RECORD_HINT = "Alt+R shows the full record, its checks and the diff.";

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
  /** Whether the result panel shows, so the latest review names its key only while it does not. */
  readonly #resultShown: () => boolean;
  #latestReview: TranscriptEntry | undefined;
  #last = "";

  constructor(theme: TesotaShellTheme, resultShown: () => boolean = () => false) {
    this.#theme = theme;
    this.#markdown = markdownTheme(theme);
    this.#resultShown = resultShown;
  }

  /** The plain text of the latest agent reply or notice, to leave on screen when the shell exits. */
  get lastMessage(): string { return this.#last; }

  add(entry: TranscriptEntry): void {
    if (entry.kind === "review") this.#latestReview = entry;
    const component = this.#render(entry);
    if (entry.kind === "user" || entry.kind === "review" || entry.kind === "notice" && !(component instanceof ExpandableNotice)) {
      let shown: Component | undefined = component;
      this.#append({
        invalidate: () => { shown = undefined; },
        render: (width) => { shown ??= this.#render(entry); return shown.render(width); },
      });
    } else this.#append(component);
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

  get noticePreviews(): readonly string[] { return this.#notices.toReversed().map((notice) => notice.preview); }

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
        box.addChild(new Text(colorText(safeTerminalText(entry.text), theme.foreground), 0, 0));
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
      case "review": return new ReviewBlock(entry.title, entry.text, theme,
        () => entry === this.#latestReview && !this.#resultShown() ? RECORD_HINT : undefined);
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
