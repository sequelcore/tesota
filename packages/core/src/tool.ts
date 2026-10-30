import type { JsonValue } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import type { ParsedCommand } from "./permissions.ts";

/** What a tool call gives back to the model: its text, and whether the call failed; an extension's tool adds its details. */
export interface ToolOutput {
  readonly text: string;
  readonly isError: boolean;
  readonly details?: JsonValue;
}

/**
 * A tool the engine runs for the model. Its arguments arrive validated
 * against `parameters`; an exception it throws reaches the model as a failed
 * call carrying the exception's message.
 */
export interface EngineTool<Parameters extends TSchema = TSchema> {
  readonly name: string;
  readonly description: string;
  readonly parameters: Parameters;
  /** What the system prompt says of the tool while it is active (#441). */
  readonly promptSnippet?: string;
  /** What a call does, for permissions (#449): only reads, writes or edits files, or runs something; runs when not said. */
  readonly access?: "read" | "write" | "run";
  /** Its rules for the system prompt while it is active; a function is read on every request (#779). */
  readonly promptGuidelines?: readonly string[] | (() => readonly string[]);
  /** A command as this shell's own parser reads it, for the floor (#697); nothing when it can't read it. */
  parse?(command: string): Promise<readonly ParsedCommand[] | undefined>;
  execute(args: Static<Parameters>, signal: AbortSignal, callId: string): Promise<ToolOutput>;
}
