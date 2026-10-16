import type { Static, TSchema } from "typebox";

/** What a tool call gives back to the model: its text, and whether the call failed. */
export interface ToolOutput {
  readonly text: string;
  readonly isError: boolean;
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
  execute(args: Static<Parameters>, signal: AbortSignal): Promise<ToolOutput>;
}
