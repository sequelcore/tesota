import type { JsonObject } from "@earendil-works/pi-ai";
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
  | "settle-can-be-cancelled"
  /** An edit whose text matches only after normalizing whitespace or Unicode fails instead of applying. */
  | "edit-matches-exactly";

/** What an engine has not built yet, with the slice of #432 that brings it. */
export type Capability = "extensions";

/** A call to a tool with its arguments. */
export interface ToolStep { readonly tool: string; readonly args: JsonObject }

/**
 * One scripted model reply: text; a call to a tool; several calls in one
 * reply, optionally cut off by the output limit; or a provider failure.
 */
export type ScriptStep =
  | string
  | ToolStep
  | { readonly calls: readonly ToolStep[]; readonly cutOff?: boolean }
  | { readonly error: string };

export interface SessionOptions {
  readonly cwd: string;
  /** The model's replies, in order, for the agent and for `modelRegistry.complete`. */
  readonly script: readonly ScriptStep[];
  readonly extensions: readonly ExtensionFactory[];
  /** Stream slowly enough for a test to act while the run is in progress. */
  readonly slow?: boolean;
}

/** An engine under test: Pi through its SDK, and `@tesota/core`. */
export interface TestEngine {
  readonly name: string;
  readonly lacks: ReadonlySet<Guarantee>;
  readonly pending: ReadonlyMap<Capability, string>;
  /** The name of the platform's shell tool: `powershell` on Windows, `bash` elsewhere. */
  readonly shell: "bash" | "powershell";
  createSession(options: SessionOptions): Promise<Session>;
  /** Disposes `session` and opens it again from what it saved, with a new script for the model. */
  resume(session: Session, options: SessionOptions): Promise<Session>;
}
