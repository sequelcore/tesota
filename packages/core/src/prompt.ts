import {
  getCurrentSystemMessage, getCurrentTools, getToolStateChanges, type Message, type SystemMessage, type Tool,
} from "@earendil-works/pi-ai";
import type { HistoryMessage } from "./loop.ts";
import { changedSections, promptStep } from "./prompt-rule.ts";
import type { EngineTool } from "./tool.ts";

/** The named parts of the system prompt after its fixed opening, in the order the model reads them (#779). */
export const sectionNames = ["explore", "tools", "guidelines", "instructions"] as const;

/** The system prompt and tools a request gives the model: the fixed opening, each section's text (empty when absent) and the tools. */
export interface PromptState {
  readonly content: string;
  readonly sections: readonly string[];
  readonly tools: readonly Tool[];
}

/** A system message of the transcript and the conversation message it comes after; the leading one comes after none. */
export interface PromptEntry {
  readonly message: SystemMessage;
  readonly after: HistoryMessage | undefined;
}

/**
 * The prompt in `cwd` with the `active` tools (#441, #779): a fixed opening,
 * with the session's `scratch` folder when it has one (#653), then what to
 * explore with, what each tool that has one says of itself, their rules,
 * trimmed and each once, and the `instructions`. A `given` prompt replaces
 * all of it.
 */
export function promptState(cwd: string, active: readonly EngineTool[], instructions: string, scratch?: string, given?: string): PromptState {
  const tools = active.map(({ name, description, parameters }) => ({ name, description, parameters }));
  if (given !== undefined) return { content: given, sections: sectionNames.map(() => ""), tools };
  const listed = active.flatMap(({ name, promptSnippet }) => promptSnippet === undefined || promptSnippet.trim() === "" ? []
    : [`- ${name}: ${promptSnippet.replace(/\s+/gu, " ").trim()}`]);
  const rules = [...new Set(active.flatMap(({ promptGuidelines }) => promptGuidelines ?? []).map((rule) => rule.trim())
    .filter((rule) => rule !== ""))].map((rule) => `- ${rule}`);
  const explorers = active.filter(({ name }) => name === "ls" || name === "find" || name === "grep").map(({ name }) => name);
  const content = [`You are a coding agent working in ${cwd}. Use the tools to read, change and run what the request needs.`,
    ...scratch === undefined ? [] : [`Write temporary files, such as a commit message, a probe script or a fixture, in ${scratch}: `
      + "the session's own scratch folder, removed when the session ends and never part of the change. "
      + `File tools may write only there and in ${cwd}; other writes are refused.`]].join("\n\n");
  return { content, tools, sections: [
    explorers.length === 0 ? "" : `Use ${explorers.join(", ")} to explore.`
      + (active.some(({ name }) => name === "bash" || name === "powershell") ? " Use the shell to run commands." : ""),
    listed.length === 0 ? "" : `Available tools:\n${listed.join("\n")}`,
    rules.length === 0 ? "" : `Guidelines:\n${rules.join("\n")}`,
    instructions,
  ] };
}

/** The prompt's text as the model reads it. */
export const promptText = (state: PromptState): string => [state.content, ...state.sections].filter((part) => part !== "").join("\n\n");

/**
 * The system message a request adds so the model has `desired` (#779): the
 * leading one while the transcript has none, then only the sections and
 * tools that changed, appended; nothing when nothing changed, so the head a
 * provider caches never moves.
 */
export function promptChange(log: readonly SystemMessage[], desired: PromptState, timestamp: number): SystemMessage | undefined {
  const current = getCurrentSystemMessage(log);
  const had = sectionNames.map((name) => current?.sections?.[name] ?? "");
  const changed = changedSections(had, desired.sections);
  const tools = getToolStateChanges(getCurrentTools(log), [...desired.tools]);
  const step = promptStep(log.length > 0, changed.includes(true), tools.toolsAdded.length + tools.toolsRemoved.length > 0);
  if (step === "none") return undefined;
  const textOf = (index: number): string => desired.sections[index] ?? "";
  if (step === "leading") {
    const sections: Record<string, string> = Object.fromEntries(sectionNames.flatMap((name, index) =>
      textOf(index) === "" ? [] : [[name, textOf(index)]]));
    return { role: "system", content: desired.content, ...Object.keys(sections).length > 0 ? { sections } : {},
      ...desired.tools.length > 0 ? { toolsAdded: [...desired.tools] } : {}, timestamp };
  }
  // A section that changed is sent whole; one that went empty is removed.
  const sections: Record<string, string | null> = Object.fromEntries(sectionNames.flatMap((name, index) => changed[index]
    ? [[name, textOf(index) === "" ? null : textOf(index)]] : []));
  return { role: "system", content: "", ...Object.keys(sections).length > 0 ? { sections } : {},
    ...tools.toolsAdded.length > 0 ? { toolsAdded: tools.toolsAdded } : {},
    ...tools.toolsRemoved.length > 0 ? { toolsRemoved: tools.toolsRemoved } : {}, timestamp };
}

/**
 * The conversation as the model reads it (#779): the leading system message,
 * then the messages, each later system message after the one it follows
 * and the call results right after that, since a provider takes a system
 * message only after the operator's turn; a settle handler's message is
 * context from the operator's side.
 */
export function modelContext(history: readonly HistoryMessage[], prompt: readonly PromptEntry[] = []): Message[] {
  const [leading, ...changes] = prompt;
  const placed = changes.map(({ message, after }) => {
    let at = after === undefined ? history.length - 1 : history.indexOf(after);
    if (at < 0) at = history.length - 1;
    while (history[at + 1]?.role === "toolResult") at += 1;
    return { message, at };
  });
  return [...leading === undefined ? [] : [leading.message], ...history.flatMap((message, index): Message[] => [
    message.role === "custom" ? { role: "user", content: message.content, timestamp: message.timestamp } : message,
    ...placed.filter(({ at }) => at === index).map(({ message: change }) => change),
  ])];
}
