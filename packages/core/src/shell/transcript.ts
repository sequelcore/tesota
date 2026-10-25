import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type CustomMessage, type HistoryMessage, jobType } from "../loop.ts";
import type { MessageRenderer, ToolDrawing } from "./surface.ts";
import type { ShellTheme } from "../../../../src/theme.ts";
import { terminalText } from "../../../../src/terminal-text.ts";
import { isStanding, standingWords } from "../../../../src/receipt.ts";

/** How extensions draw their messages and tool calls (#446), and whether drawings are expanded. */
export interface Drawings {
  readonly renderers: ReadonlyMap<string, MessageRenderer>;
  readonly tools: ReadonlyMap<string, ToolDrawing>;
  readonly expanded: () => boolean;
  readonly cwd: string;
}

const noDrawings: Drawings = { renderers: new Map(), tools: new Map(), expanded: () => false, cwd: "" };

/** How many lines of a call's output the conversation shows before it says how many more there are. */
const outputLines = 12;

const textOf = (content: string | readonly { type: string; text?: string }[]): string => typeof content === "string" ? content
  : content.flatMap((part) => part.type === "text" && part.text !== undefined ? [part.text] : []).join("");

/** Rows drawn once per width, as pi-tui's `Text` keeps its lines: the shell repaints every frame. */
function cached(rows: (width: number) => string[], invalidate: () => void = () => undefined): Component {
  let drawn: { readonly width: number; readonly lines: string[] } | undefined;
  return {
    invalidate: () => { drawn = undefined; invalidate(); },
    render: (width) => {
      if (drawn?.width !== width) drawn = { width, lines: rows(width) };
      return drawn.lines;
    },
  };
}

/** The column every entry starts at, as a reply's Markdown is padded, so prompts, calls and replies line up. */
const MARGIN = " ";

/** Text wrapped under a two-column prefix past the margin, with continuation lines aligned under the text. */
function prefixedText(text: string, prefix: string): Component {
  const body = new Text(text, 0, 0);
  return cached((width) => body.render(Math.max(1, width - MARGIN.length - 2)).map((line, index) =>
    truncateToWidth(`${MARGIN}${index === 0 ? prefix : "  "}${line}`, width)), () => { body.invalidate(); });
}

/** The operator's full-width prompt band; quoted terminal controls never reach the terminal. */
function userView(text: string, theme: ShellTheme): Component {
  return cached((width) => {
    const body = prefixedText(theme.fg("userMessageText", terminalText(text)), theme.bold(theme.fg(theme.appearance === "light" ? "muted" : "dim", "› ")));
    return body.render(width).map((line) => theme.bg("userMessageBg",
      line + " ".repeat(Math.max(0, width - visibleWidth(line)))));
  });
}

/** A reply: its thinking, quieter, then its text as Markdown. */
class ReplyView extends Container {
  private readonly theme: ShellTheme;
  constructor(theme: ShellTheme) {
    super();
    this.theme = theme;
  }
  show(message: AssistantMessage): void {
    this.clear();
    for (const part of message.content) {
      if (part.type === "thinking" && part.thinking.trim() !== "") {
        this.addChild(new Text(this.theme.italic(this.theme.fg("thinkingText", part.thinking.trim())), 1, 0));
      } else if (part.type === "text" && part.text.trim() !== "") {
        this.addChild(new Markdown(part.text.trim(), 1, 0, this.theme.markdown));
      }
    }
    if (message.stopReason === "error" && message.errorMessage !== undefined) {
      this.addChild(new Text(this.theme.fg("error", message.errorMessage), 1, 0));
    }
  }
}

/** What a call's arguments say in one line: its pattern and path, its path, or its command. */
function summary(call: ToolCall): string {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const text =(value: unknown): string => typeof value === "string" ? value.split("\n")[0] ?? "" : "";
  // A search shows what it looks for, then where: `quesillo in notes`.
  if (typeof args["pattern"] === "string") return [text(args["pattern"]), text(args["path"])].filter((part) => part !== "").join(" in ");
  return text(args["path"] ?? args["command"] ?? args["description"]);
}

/** A subagent's line under the call that started it (#525): its type, model and depth, and where it stands. */
function childLine(details: unknown, theme: ShellTheme): string | undefined {
  if (typeof details !== "object" || details === null) return undefined;
  const { type, model, depth, writes } = details as Record<string, unknown>;
  return `${theme.fg("dim", "↳")} ${theme.fg("muted", [typeof type === "string" ? type : "agent", writes === true ? "writes" : "reads",
    String(model), `depth ${String(depth)}`].join(" · "))} ${theme.fg("dim", "·")} ${childStanding(details, theme)}`;
}

/** Where a subagent stands: working, or how it ended, its receipt's standing, and the limit that stopped it. */
function childStanding(details: unknown, theme: ShellTheme): string {
  const { outcome, verification, limited } = (details ?? {}) as Record<string, unknown>;
  if (outcome === "running") return theme.fg("accent", "working");
  return `${String(outcome)}${isStanding(verification) ? `, ${standingWords[verification]}` : ""}${typeof limited === "string" ? ` (${limited} limit)` : ""}`;
}

/** An edit's replacements as removed and added lines; arguments the model malformed draw none. */
export function diffLines(call: { readonly arguments: unknown }): string[] {
  const edits: unknown = (call.arguments as { edits?: unknown } | undefined)?.edits;
  const lines = (text: unknown, prefix: string): string[] => {
    const value = typeof text === "string" ? text : "";
    return value === "" ? [] : value.replace(/\r?\n$/u, "").split(/\r?\n/u).map((line) => `${prefix} ${line}`);
  };
  return Array.isArray(edits) ? edits.flatMap((edit: unknown) => {
    const { oldText, newText } = (typeof edit === "object" && edit !== null ? edit : {}) as { oldText?: unknown; newText?: unknown };
    return [...lines(oldText, "-"), ...lines(newText, "+")];
  }) : [];
}

/** A call's status, tool and target, with details when expanded and failures always visible. */
class CallView extends Container {
  private result: ToolResultMessage | undefined;
  private readonly call: ToolCall;
  private readonly theme: ShellTheme;
  private readonly drawings: Drawings;
  private readonly startedAt = Date.now();
  private durationMs: number | undefined;
  /** The subagent the call started (#525), as its job last said. */
  private child: unknown;
  constructor(call: ToolCall, theme: ShellTheme, drawings: Drawings) {
    super();
    this.call = call;
    this.theme = theme;
    this.drawings = drawings;
    this.draw();
  }
  /** The subagent the call started, as its job now says (#525). */
  job(details: unknown): void {
    this.child = details;
    this.draw();
  }
  finish(result: ToolResultMessage): void {
    this.result = result;
    // A call that waited for its subagent carries its end; one in the background only started it.
    if (result.details !== undefined && this.call.name === "agent") this.child = result.details;
    this.durationMs = Date.now() - this.startedAt;
    this.draw();
  }
  private draw(): void {
    this.clear();
    const { theme, call, result } = this;
    const drawing = this.drawings.tools.get(call.name);
    if (drawing !== undefined) { this.drawn(drawing); return; }
    const glyph = result === undefined ? "○" : result.isError ? "✗" : "✓";
    const diff = call.name === "edit" && result?.isError !== true ? diffLines(call) : [];
    const note = result !== undefined && diff.length > 0
      ? ` ${theme.fg("dim", `+${diff.filter((line) => line.startsWith("+")).length} −${diff.filter((line) => line.startsWith("-")).length}`)}` : "";
    const title = `${theme.fg(result?.isError === true ? "error" : "muted", glyph)} ${theme.bold(theme.fg("toolTitle", call.name))}`
      + ` ${theme.fg("muted", summary(call))}${note}`;
    this.addChild(cached((width) => [truncateToWidth(`${MARGIN}${title}`, width)]));
    this.drawChild();
    const lines: string[] = [];
    const expanded = this.drawings.expanded();
    if (expanded && diff.length > 0) {
      lines.push(...diff.map((line) => theme.fg(line.startsWith("-") ? "toolDiffRemoved" : "toolDiffAdded", line)));
    } else if (result !== undefined && (expanded || result.isError)) {
      const output = textOf(result.content).trimEnd().split("\n");
      lines.push(...output.slice(0, expanded ? outputLines : 1).map((line) => theme.fg(result.isError ? "error" : "toolOutput", line)));
      if (expanded && output.length > outputLines) lines.push(theme.fg("dim", `… ${output.length - outputLines} more lines`));
    }
    if (lines.length > 0) this.addChild(prefixedText(lines.join("\n"), "  "));
  }
  /** The line of the subagent the call started, when it started one (#525). */
  private drawChild(): void {
    const child = childLine(this.child, this.theme);
    if (child !== undefined) this.addChild(cached((width) => [truncateToWidth(`${MARGIN}  ${child}`, width)]));
  }
  /** A call drawn as its extension's tool says, Pi's way: its call, then its result once there is one. */
  private drawn(drawing: ToolDrawing): void {
    const { call, result } = this;
    const expanded = this.drawings.expanded();
    const box = new Container();
    if (drawing.renderCall !== undefined) box.addChild(drawing.renderCall(call.arguments, this.theme, { durationMs: this.durationMs }));
    if (drawing.renderResult !== undefined) {
      const shown = result === undefined ? { content: [], details: undefined } : { content: result.content, details: result.details,
        isError: result.isError };
      box.addChild(drawing.renderResult(shown as never, { expanded, isPartial: result === undefined }, this.theme));
    }
    const state = result === undefined ? "toolPendingBg" : result.isError ? "toolErrorBg" : "toolSuccessBg";
    this.addChild(new Text("", 0, 0, (line) => this.theme.bg(state, line)));
    this.addChild(box);
  }
}

/** A background subagent's end (#525): one line, and its report once expanded. */
function jobView(message: CustomMessage, theme: ShellTheme, drawings: Drawings): Component {
  const details = (message.details ?? {}) as Record<string, unknown>;
  const title = `${theme.fg("dim", "↳")} ${theme.bold(theme.fg("toolTitle", "subagent"))} ${theme.fg("muted", String(details["description"] ?? ""))}`
    + ` ${theme.fg("dim", "·")} ${childStanding(details, theme)}`;
  const head = cached((width) => [truncateToWidth(`${MARGIN}${title}`, width)]);
  if (!drawings.expanded()) return head;
  const box = new Container();
  box.addChild(head);
  box.addChild(prefixedText(theme.fg("toolOutput", terminalText(message.content)), "  "));
  return box;
}

/** A message a settle handler added: as its extension draws it (#446), or as plain text when it draws none. */
function customView(message: CustomMessage, theme: ShellTheme, drawings: Drawings): Component {
  if (message.customType === jobType) return jobView(message, theme, drawings);
  const renderer = drawings.renderers.get(message.customType);
  const drawn = renderer?.(message, { expanded: drawings.expanded(), outputPad: 1 }, theme);
  if (drawn !== undefined) return drawn;
  return new Text(`${theme.fg("customMessageLabel", `[${message.customType}]`)} ${theme.fg("customMessageText", message.content)}`,
    1, 1, (line) => theme.bg("customMessageBg", line));
}

/**
 * The conversation as the shell draws it (#444): each message once it
 * enters, the reply as it streams, and each call from its start to its
 * result. Built again from the history when a session is resumed.
 */
export class Transcript extends Container {
  private streaming: ReplyView | undefined;
  private readonly calls = new Map<string, CallView>();
  private readonly theme: ShellTheme;
  private readonly drawings: Drawings;
  constructor(theme: ShellTheme, drawings: Drawings = noDrawings) {
    super();
    this.theme = theme;
    this.drawings = drawings;
  }

  /** Draws `history` from the start, as a resumed session has it. */
  load(history: readonly HistoryMessage[]): void {
    this.clear();
    this.calls.clear();
    this.streaming = undefined;
    for (const message of history) this.add(message);
  }

  /** The reply as it streams so far. */
  stream(partial: AssistantMessage): void {
    if (this.streaming === undefined) {
      this.streaming = new ReplyView(this.theme);
      this.addChild(this.streaming);
    }
    this.streaming.show(partial);
  }

  /** A call that started. */
  start(call: ToolCall): void {
    if (this.calls.has(call.id)) return;
    const view = new CallView(call, this.theme, this.drawings);
    this.calls.set(call.id, view);
    this.addChild(view);
  }

  /** A subagent's job, as it now stands, under the call that started it (#525). */
  job(callId: string, details: unknown): void {
    this.calls.get(callId)?.job(details);
  }

  /** A message that entered the conversation. */
  add(message: HistoryMessage): void {
    if (message.role === "user") this.addChild(userView(textOf(message.content), this.theme));
    else if (message.role === "assistant") {
      const view = this.streaming ?? new ReplyView(this.theme);
      if (this.streaming === undefined) this.addChild(view);
      this.streaming = undefined;
      view.show(message);
      for (const part of message.content) if (part.type === "toolCall") this.start(part);
    } else if (message.role === "toolResult") {
      const view = this.calls.get(message.toolCallId);
      if (view === undefined) {
        const call: ToolCall = { type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} };
        this.start(call);
      }
      this.calls.get(message.toolCallId)?.finish(message);
    } else if (message.role === "custom" && message.display) this.addChild(customView(message, this.theme, this.drawings));
  }

  /** Each entry that draws anything, one blank row between them: a reply that only called tools draws nothing and adds no row. */
  override render(width: number): string[] {
    return this.children.map((child) => child.render(width)).filter((lines) => lines.length > 0)
      .flatMap((lines, index) => index === 0 ? lines : ["", ...lines]);
  }
}
