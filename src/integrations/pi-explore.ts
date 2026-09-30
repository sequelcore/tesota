import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { canStartHelper } from "../verification/helper-answer.js";
import type { ExplorerResult } from "./pi-explorer.js";
import { Semaphore } from "../semaphore.js";
import { runCost, type TokenUsage, totalTokens } from "../token-usage.js";

/**
 * The working agent's `explore` tool (decision 019): each call asks one
 * read-only explorer one question. The pool bounds how many run at once and
 * how many a turn may start; the working agent stays the only writer.
 */

export const EXPLORER_CONCURRENCY = 3;
export const EXPLORERS_PER_TURN = 8;

/** What asking an explorer reports back: its result, and what it cost. */
export interface ExplorerRun {
  readonly result: ExplorerResult;
  readonly durationMs: number;
  readonly tokens: number;
}

/** Ask one explorer; `onLine` receives one line per file the explorer reads or searches, as it happens. */
export type AskExplorer = (brief: string, signal: AbortSignal, onLine: (line: string) => void,
  onUsage: (usage: TokenUsage) => void) => Promise<ExplorerResult>;

export class ExplorerPool {
  readonly #ask: AskExplorer;
  readonly #places: Semaphore;
  readonly #perTurn: number;
  #started = 0;

  constructor(ask: AskExplorer, concurrency: number = EXPLORER_CONCURRENCY, perTurn: number = EXPLORERS_PER_TURN) {
    this.#ask = ask;
    this.#places = new Semaphore(concurrency);
    this.#perTurn = perTurn;
  }

  /** A new request from the operator starts a new turn's allowance. */
  startTurn(): void { this.#started = 0; }

  async run(brief: string, signal: AbortSignal, onLine: (line: string) => void): Promise<ExplorerRun> {
    const refused = (reason: string): ExplorerRun => ({ result: { status: "unfinished", reason }, durationMs: 0, tokens: 0 });
    if (!canStartHelper(this.#started, this.#perTurn)) {
      return refused(`this turn already asked ${this.#perTurn} explorers; continue with what you have`);
    }
    this.#started += 1;
    if (!await this.#places.acquire(signal)) return refused("the explorer was stopped before it started");
    const started = Date.now();
    let tokens = 0;
    try {
      const result = await this.#ask(brief, signal, onLine, (usage) => { tokens += totalTokens(usage); });
      return { result, durationMs: Date.now() - started, tokens };
    } catch (error) {
      return { result: { status: "unfinished", reason: error instanceof Error ? error.message : "the explorer failed" },
        durationMs: Date.now() - started, tokens };
    } finally { this.#places.release(); }
  }
}

/** What the agent reads back from one explorer. */
export function exploreResult(run: ExplorerRun): string {
  if (run.result.status === "unfinished") return `The explorer did not answer: ${run.result.reason}.`;
  return `Explorer's answer (${runCost(run.durationMs, run.tokens)}); check what you rely on:\n\n${run.result.answer}`;
}

const activityLines = 8;

export function exploreTool(pool: ExplorerPool): ToolDefinition {
  return defineTool({
    name: "explore", label: "Explore",
    description: "Ask a read-only explorer one question about the repository; it reads and searches in its own " +
      "conversation and returns a short answer that cites files and lines. Use it when answering needs reading " +
      "many files, or for independent questions, which you may ask in parallel. Do the small, targeted reads " +
      "yourself. The explorer cannot change files or run commands, and does not see this conversation, so write " +
      "a question that stands on its own: what to find out and why.",
    parameters: Type.Object({ question: Type.String({ description: "One self-contained question, with the context the explorer needs" }) }),
    executionMode: "parallel",
    execute: async (_id, params, signal, onUpdate) => {
      const lines: string[] = [];
      const run = await pool.run(params.question, signal ?? new AbortController().signal, (line) => {
        lines.push(line);
        onUpdate?.({ content: [{ type: "text", text: lines.slice(-activityLines).join("\n") }], details: undefined });
      });
      return { content: [{ type: "text", text: exploreResult(run) }], details: undefined };
    },
  });
}
