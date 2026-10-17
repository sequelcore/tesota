import { type TSchema, Type } from "typebox";
import { type ModelAccess, named, recorded, registered } from "./pi-claimcheck.js";

/**
 * A model's list of the cases the operator's request leaves open: inputs
 * for which someone who made the request could expect more than one result
 * (#397). The agent settles such a case silently, in code and a contract
 * that prove either way, so the receipt lists them for the operator to
 * settle. The list is a model's opinion, never evidence and never a verdict,
 * and it does not go back to the agent. It reads the request alone: shown
 * the agent's change as well, models listed more false alarms. Measured
 * before it shipped, with this prompt (#397).
 */

/** The model that lists open cases unless the operator names another: GPT-6 Sol met every threshold, GPT-6 Luna did not. */
export const OPEN_CASES_MODEL = "openai/gpt-6-sol";

/** The list ends within this, so a stalled provider cannot hold the run open. */
export const OPEN_CASES_TIME_LIMIT_MS: number = 2 * 60_000;

/** One case the request leaves open: the input, and the results someone could expect from it. */
export interface OpenCase {
  readonly input: string;
  readonly outcomes: readonly string[];
}

/** The open cases a model listed, with the model as `provider/id`, or why none were listed. */
export type OpenCases =
  | { readonly status: "listed"; readonly model: string; readonly cases: readonly OpenCase[] }
  | { readonly status: "not_listed"; readonly reason: string };

const listSchema: TSchema = Type.Object({ cases: Type.Array(Type.Object({ input: Type.String(), outcomes: Type.Array(Type.String()) })) });

export const openCasesSystemPrompt =
  "You read requests people give coding agents and find what they leave open. Answer only through the tool you are given.";

/** What the model is asked about the operator's `requests`, every message of one request in order. */
export function openCasesPrompt(requests: readonly string[]): string {
  return `A person gave a coding agent this request:\n\n${requests.join("\n\n")}\n\n` +
    "List each input case the request does not settle: an input for which a reasonable person who made the request could " +
    "expect more than one result. For each, give the input and the results someone could expect. Leave out cases the " +
    "request settles, and anything about how the code or its proof is written. If the request settles every case, list none. " +
    "Leave out inputs of a kind the request never mentions, such as NaN, Infinity, -0, or values that are not of the type it names.";
}

/** The open cases of `requests`, listed by `model`, a `provider/id` in Pi's model registry, within `OPEN_CASES_TIME_LIMIT_MS`. */
export async function openCases(ctx: ModelAccess, requests: readonly string[], model: string, signal: AbortSignal): Promise<OpenCases> {
  const lister = registered(ctx, model);
  if (lister === undefined) return { status: "not_listed", reason: `${model} is not a provider/id in Pi's model registry` };
  const listed = await recorded<{ cases: OpenCase[] }>(ctx, lister, openCasesSystemPrompt, "record_open_cases", listSchema,
    openCasesPrompt(requests), AbortSignal.any([signal, AbortSignal.timeout(OPEN_CASES_TIME_LIMIT_MS)]));
  return typeof listed === "string" ? { status: "not_listed", reason: `${named(lister)} ${listed}` }
    : { status: "listed", model: named(lister), cases: listed.cases };
}
