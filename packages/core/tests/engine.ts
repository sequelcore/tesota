import type { Context, JsonObject, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionFactory, Session } from "../../../src/contract.ts";
import type { LedgerRequest } from "../src/session.ts";

/** A call to a tool with its arguments. */
export interface ToolStep { readonly tool: string; readonly args: JsonObject }

/**
 * One scripted model reply: text; a call to a tool; several calls in one
 * reply, optionally cut off by the output limit; a provider failure; or a
 * reply given after `seen` looks at what the model was sent.
 */
export type ScriptStep =
  | string
  | ToolStep
  | { readonly calls: readonly ToolStep[]; readonly cutOff?: boolean }
  | { readonly error: string }
  | { readonly seen: (context: Context, options: SimpleStreamOptions | undefined) => void; readonly reply: string };

export interface SessionOptions {
  readonly cwd: string;
  /** The model's replies, in order, for the agent and for `modelRegistry.complete`. */
  readonly script: readonly ScriptStep[];
  readonly extensions: readonly ExtensionFactory[];
  /** What verifies each run, given the ledger's request; one that settles every run when not given. */
  readonly verifier?: (pi: ExtensionAPI, request?: () => LedgerRequest | undefined) => void;
  /** Stream slowly enough for a test to act while the run is in progress. */
  readonly slow?: boolean;
}

/** The engine under test. */
export interface TestEngine {
  readonly name: string;
  /** The name of the platform's shell tool: `powershell` on Windows, `bash` elsewhere. */
  readonly shell: "bash" | "powershell";
  createSession(options: SessionOptions): Promise<Session>;
  /** Disposes `session` and opens it again from what it saved, with a new script for the model. */
  resume(session: Session, options: SessionOptions): Promise<Session>;
}
