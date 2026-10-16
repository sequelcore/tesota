import type { AssistantMessage, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { CustomMessage, HistoryMessage } from "../loop.ts";
import type { ShellTheme } from "./theme.ts";

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
  constructor(call: ToolCall, theme: ShellTheme) {
    super();
    this.call = call;
    this.theme = theme;
    this.draw();
  }
  finish(result: ToolResultMessage): void {
    this.result = result;
    this.draw();
  }
  private draw(): void {
    this.clear();
    const { theme, call, result } = this;
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
}

/** A message a settle handler added, as plain text until the shell draws Tesota's (#446). */
function customView(message: CustomMessage, theme: ShellTheme): Component {
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
  constructor(theme: ShellTheme) {
    super();
    this.theme = theme;
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
    const view = new CallView(call, this.theme);
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
    } else if (message.role === "custom") this.append(customView(message, this.theme));
  }

  private append(component: Component): void {
    if (this.children.length > 0) this.addChild(new Spacer(1));
    this.addChild(component);
  }
}
