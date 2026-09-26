import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { canStartHelper } from "../verification/helper-answer.js";
import type { HelperResult } from "./pi-helper.js";

/**
 * The working agent's `explore` tool (decision 019): each call asks one
 * read-only helper one question. The pool bounds how many run at once and
 * how many a turn may start; the working agent stays the only writer.
 */

export const HELPER_CONCURRENCY = 3;
export const HELPERS_PER_TURN = 8;

/** What asking a helper reports back: its result, and what it cost. */
export interface HelperRun {
  readonly result: HelperResult;
  readonly durationMs: number;
  readonly tokens: number;
}

/** Ask one helper; `onLine` receives one line per file the helper reads or searches, as it happens. */
export type AskHelper = (brief: string, signal: AbortSignal, onLine: (line: string) => void,
  onUsage: (tokens: number) => void) => Promise<HelperResult>;

export class HelperPool {
  readonly #ask: AskHelper;
  readonly #concurrency: number;
  readonly #perTurn: number;
  #running = 0;
  #started = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(ask: AskHelper, concurrency: number = HELPER_CONCURRENCY, perTurn: number = HELPERS_PER_TURN) {
    this.#ask = ask;
    this.#concurrency = concurrency;
    this.#perTurn = perTurn;
  }

  /** A new request from the operator starts a new turn's allowance. */
  startTurn(): void { this.#started = 0; }

  async run(brief: string, signal: AbortSignal, onLine: (line: string) => void): Promise<HelperRun> {
    const refused = (reason: string): HelperRun => ({ result: { status: "unfinished", reason }, durationMs: 0, tokens: 0 });
    if (!canStartHelper(this.#started, this.#perTurn)) {
      return refused(`this turn already asked ${this.#perTurn} helpers; continue with what you have`);
    }
    this.#started += 1;
    if (!await this.#acquire(signal)) return refused("the helper was stopped before it started");
    const started = Date.now();
    let tokens = 0;
    try {
      const result = await this.#ask(brief, signal, onLine, (count) => { tokens += count; });
      return { result, durationMs: Date.now() - started, tokens };
    } catch (error) {
      return { result: { status: "unfinished", reason: error instanceof Error ? error.message : "the helper failed" },
        durationMs: Date.now() - started, tokens };
    } finally { this.#release(); }
  }

  async #acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.#running < this.#concurrency) { this.#running += 1; return true; }
    return new Promise((settle) => {
      const grant = (): void => { signal.removeEventListener("abort", abort); this.#running += 1; settle(true); };
      const abort = (): void => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        settle(false);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#waiting.push(grant);
    });
  }

  #release(): void {
    this.#running -= 1;
    this.#waiting.shift()?.();
  }
}

function cost(run: HelperRun): string {
  const tokens = run.tokens < 1_000 ? `${run.tokens} tokens` : `${Math.round(run.tokens / 1_000)}k tokens`;
  return `${Math.max(1, Math.round(run.durationMs / 1_000))} s, ${tokens}`;
}

/** What the agent reads back from one helper. */
export function exploreResult(run: HelperRun): string {
  if (run.result.status === "unfinished") return `The helper did not answer: ${run.result.reason}.`;
  return `Helper's answer (${cost(run)}); check what you rely on:\n\n${run.result.answer}`;
}

const activityLines = 8;

export function exploreTool(pool: HelperPool): ToolDefinition {
  return defineTool({
    name: "explore", label: "Explore",
    description: "Ask a read-only helper one question about the repository; it reads and searches in its own " +
      "conversation and returns a short answer that cites files and lines. Use it when answering needs reading " +
      "many files, or for independent questions, which you may ask in parallel. Do the small, targeted reads " +
      "yourself. The helper cannot change files or run commands, and does not see this conversation, so write " +
      "a question that stands on its own: what to find out and why.",
    parameters: Type.Object({ question: Type.String({ description: "One self-contained question, with the context the helper needs" }) }),
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
