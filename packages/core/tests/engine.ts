import type { ExtensionFactory, Session } from "../src/contract.ts";

/**
 * Guarantees Tesota needs that go beyond Pi's behavior. An engine that lacks
 * one runs its test as expected to fail, so the gap stays visible and a
 * change in Pi's behavior shows up as a failing test.
 */
export type Guarantee =
  /** A later settle handler cannot drop an earlier one's messages or cancel its send-back. */
  | "settle-results-accumulate"
  /** A settle handler that throws ends the run as `incomplete`, never as done. */
  | "settle-failure-is-incomplete"
  /** Settle handlers get an abort signal, so the operator can stop verification (#408). */
  | "settle-can-be-cancelled";

/** One scripted model reply: text, or a call to a tool with its arguments. */
export type ScriptStep = string | { readonly tool: string; readonly args: Record<string, string | number | boolean> };

export interface SessionOptions {
  readonly cwd: string;
  /** The model's replies, in order, for the agent and for `modelRegistry.complete`. */
  readonly script: readonly ScriptStep[];
  readonly extensions: readonly ExtensionFactory[];
  /** Stream slowly enough for a test to act while the run is in progress. */
  readonly slow?: boolean;
}

/** An engine under test: Pi through its SDK, and later `@tesota/core`. */
export interface TestEngine {
  readonly name: string;
  readonly lacks: ReadonlySet<Guarantee>;
  createSession(options: SessionOptions): Promise<Session>;
}
