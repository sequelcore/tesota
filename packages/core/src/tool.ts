import type { JsonValue } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";

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
  readonly promptGuidelines?: readonly string[];
  execute(args: Static<Parameters>, signal: AbortSignal, callId: string): Promise<ToolOutput>;
}
