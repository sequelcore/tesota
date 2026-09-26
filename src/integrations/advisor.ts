import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { canStartHelper } from "../verification/helper-answer.js";
import { runCost, type TokenUsage, totalTokens } from "../token-usage.js";
import type { ConversationEntry } from "./model-session-contract.js";
import type { ExplorerResult } from "./pi-explorer.js";

/**
 * The working agent's advisor (decision 027): a stronger model the agent
 * consults at hard decisions. As in Anthropic's advisor tool, the advisor
 * reads the agent's conversation and has no tools, so it can change nothing
 * and nothing it reads can make it act; the agent stays the only writer, and
 * the advice is advice, never review evidence.
 */

/** Consults a request may make; Anthropic suggests about two to three for a coding task. */
export const ADVISOR_CONSULTS_PER_TURN = 3;
/** The advisor reads at most this much of the conversation: the first request, then the newest entries. */
export const ADVISOR_CONVERSATION_LIMIT = 200_000;
const toolResultLimit = 4_000;

const labels: Readonly<Record<ConversationEntry["role"], string>> = { user: "user", assistant: "agent",
  tool_call: "tool call", tool_result: "tool result" };

function renderEntry(entry: ConversationEntry): string {
  const text = entry.role === "tool_result" && entry.text.length > toolResultLimit
    ? `${entry.text.slice(0, toolResultLimit)}\n[The result is cut here.]` : entry.text;
  return `[${labels[entry.role]}]\n${text}`;
}

/**
 * The conversation as the advisor reads it. When it is longer than `limit`,
 * the first entry, the operator's first request, is kept with the newest
 * entries that fit, and the omission is stated.
 */
export function renderConversation(entries: readonly ConversationEntry[], limit: number = ADVISOR_CONVERSATION_LIMIT): string {
  const rendered = entries.map(renderEntry);
  const whole = rendered.join("\n\n");
  if (whole.length <= limit || rendered.length === 0) return whole;
  const [first = "", ...rest] = rendered;
  const kept: string[] = [];
  let size = first.length + 60;
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const entry = rest[index] ?? "";
    if (size + entry.length + 2 > limit) break;
    kept.unshift(entry);
    size += entry.length + 2;
  }
  return [first, `[${rest.length - kept.length} earlier entries are left out.]`, ...kept].join("\n\n");
}

/** Ask the advisor once, about the conversation as it stands; `question` focuses it when the agent gives one. */
export type ConsultAdvisor = (question: string | undefined, signal: AbortSignal,
  onUsage: (usage: TokenUsage) => void) => Promise<ExplorerResult>;

/** What one consult reports back: the result, and what it cost. */
export interface AdvisorRun {
  readonly result: ExplorerResult;
  readonly durationMs: number;
  readonly tokens: number;
}

/** The session's advisor: consults one at a time, at most `perTurn` for each of the operator's requests. */
export class Advisor {
  readonly #consult: ConsultAdvisor;
  readonly #perTurn: number;
  #started = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(consult: ConsultAdvisor, perTurn: number = ADVISOR_CONSULTS_PER_TURN) {
    this.#consult = consult;
    this.#perTurn = perTurn;
  }

  /** A new request from the operator starts a new turn's allowance. */
  startTurn(): void { this.#started = 0; }

  consult(question: string | undefined, signal: AbortSignal): Promise<AdvisorRun> {
    if (!canStartHelper(this.#started, this.#perTurn)) {
      return Promise.resolve({ result: { status: "unfinished", reason: `this request already consulted the advisor ` +
        `${this.#perTurn} times; decide with what you have` }, durationMs: 0, tokens: 0 });
    }
    this.#started += 1;
    const run = this.#queue.then(() => this.#run(question, signal));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #run(question: string | undefined, signal: AbortSignal): Promise<AdvisorRun> {
    const started = Date.now();
    let tokens = 0;
    try {
      const result = await this.#consult(question, signal, (usage) => { tokens += totalTokens(usage); });
      return { result, durationMs: Date.now() - started, tokens };
    } catch (error) {
      return { result: { status: "unfinished", reason: error instanceof Error ? error.message : "the advisor failed" },
        durationMs: Date.now() - started, tokens };
    }
  }
}

/** What the agent reads back from one consult. */
export function advisorResult(run: AdvisorRun): string {
  if (run.result.status === "unfinished") return `The advisor did not answer: ${run.result.reason}.`;
  return `Advisor's guidance (${runCost(run.durationMs, run.tokens)}); weigh it against what you have verified:\n\n` +
    run.result.answer;
}

export function advisorTool(advisor: Advisor): ToolDefinition {
  return defineTool({
    name: "advisor", label: "Advisor",
    description: "Consult a stronger advisor model. It reads this whole conversation, the task, every tool call and " +
      "result, and returns a plan, a correction or a reason to stop. It cannot read files or run anything, so make " +
      "sure what it needs is in the conversation. Optionally ask a focused question, for example to reconcile what " +
      "you found with its earlier advice.",
    parameters: Type.Object({ question: Type.Optional(Type.String({ description: "What you want the advisor's view on; " +
      "omit it for general guidance at this point" })) }),
    execute: async (_id, params, signal) => {
      const run = await advisor.consult(params.question, signal ?? new AbortController().signal);
      return { content: [{ type: "text", text: advisorResult(run) }], details: undefined };
    },
  });
}

/**
 * When to consult and how to treat the advice, adapted from Anthropic's
 * suggested timing and advice blocks for coding tasks (decision 027).
 */
export const ADVISOR_GUIDANCE: string = "The advisor tool consults a stronger model that reads this whole conversation. " +
  "Call advisor before substantive work: before writing, before committing to an interpretation, before building on " +
  "an assumption; orient first (find and read the relevant files), then call it. Also call it when you believe the " +
  "task is complete, after your changes are written; when stuck, with errors recurring or an approach not " +
  "converging; and when considering a change of approach. On short tasks whose next step is dictated by what you " +
  "just read, you need not call it. Give the advice serious weight, but adapt when a step fails empirically or the " +
  "code contradicts a specific claim. If your evidence points one way and the advice another, do not silently " +
  "switch: call the advisor once more with the conflict. ";
