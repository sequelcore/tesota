import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { CustomMessage, HistoryMessage } from "../loop.ts";
import type { MessageRenderer, ToolDrawing } from "./surface.ts";
import type { ShellTheme } from "../../../../src/theme.ts";

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

/** The operator's message, on its own background. */
function userView(text: string, theme: ShellTheme): Component {
  return new Text(theme.fg("userMessageText", text), 1, 1, (line) => theme.bg("userMessageBg", line));
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

/** What a call's arguments say in one line: its path or its command. */
function summary(call: ToolCall): string {
  const args = call.arguments as Record<string, unknown>;
  const said = args["path"] ?? args["command"];
  return typeof said === "string" ? said.split("\n")[0] ?? "" : "";
}

/** An edit's replacements as removed and added lines. */
function diffLines(call: ToolCall, theme: ShellTheme): string[] {
  const edits = (call.arguments as { edits?: { oldText?: unknown; newText?: unknown }[] }).edits ?? [];
  return edits.flatMap(({ oldText, newText }) => [
    ...String(oldText ?? "").split("\n").map((line) => theme.fg("toolDiffRemoved", `- ${line}`)),
    ...String(newText ?? "").split("\n").map((line) => theme.fg("toolDiffAdded", `+ ${line}`)),
  ]);
}

/** A call: its tool and target, then its diff or the start of its output, on a background that says how it went. */
class CallView extends Container {
  private result: ToolResultMessage | undefined;
  private readonly call: ToolCall;
  private readonly theme: ShellTheme;
  private readonly drawings: Drawings;
  private readonly startedAt = Date.now();
  private durationMs: number | undefined;
  constructor(call: ToolCall, theme: ShellTheme, drawings: Drawings) {
    super();
    this.call = call;
    this.theme = theme;
    this.drawings = drawings;
    this.draw();
  }
  finish(result: ToolResultMessage): void {
    this.result = result;
    this.durationMs = Date.now() - this.startedAt;
    this.draw();
  }
  private draw(): void {
    this.clear();
    const { theme, call, result } = this;
    const drawing = this.drawings.tools.get(call.name);
    if (drawing !== undefined) { this.drawn(drawing); return; }
    const state = result === undefined ? "toolPendingBg" : result.isError ? "toolErrorBg" : "toolSuccessBg";
    const lines = [`${theme.bold(theme.fg("toolTitle", call.name))} ${theme.fg("muted", summary(call))}`];
    if (call.name === "edit" && result?.isError !== true) lines.push(...diffLines(call, theme));
    else if (result !== undefined) {
      const output = textOf(result.content).trimEnd().split("\n");
      lines.push(...output.slice(0, outputLines).map((line) => theme.fg("toolOutput", line)));
      if (output.length > outputLines) lines.push(theme.fg("dim", `… ${output.length - outputLines} more lines`));
    }
    this.addChild(new Text(lines.join("\n"), 1, 1, (line) => theme.bg(state, line)));
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

/** A message a settle handler added: as its extension draws it (#446), or as plain text when it draws none. */
function customView(message: CustomMessage, theme: ShellTheme, drawings: Drawings): Component {
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
      this.append(this.streaming);
    }
    this.streaming.show(partial);
  }

  /** A call that started. */
  start(call: ToolCall): void {
    if (this.calls.has(call.id)) return;
    const view = new CallView(call, this.theme, this.drawings);
    this.calls.set(call.id, view);
    this.append(view);
  }

  /** A message that entered the conversation. */
  add(message: HistoryMessage): void {
    if (message.role === "user") this.append(userView(textOf(message.content), this.theme));
    else if (message.role === "assistant") {
      const view = this.streaming ?? new ReplyView(this.theme);
      if (this.streaming === undefined) this.append(view);
      this.streaming = undefined;
      view.show(message);
    } else if (message.role === "toolResult") {
      const view = this.calls.get(message.toolCallId);
      if (view === undefined) {
        const call: ToolCall = { type: "toolCall", id: message.toolCallId, name: message.toolName, arguments: {} };
        this.start(call);
      }
      this.calls.get(message.toolCallId)?.finish(message);
    } else if (message.role === "custom" && message.display) this.append(customView(message, this.theme, this.drawings));
  }

  private append(component: Component): void {
    if (this.children.length > 0) this.addChild(new Spacer(1));
    this.addChild(component);
  }
}
