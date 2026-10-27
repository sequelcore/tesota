import { type TSchema, Type } from "typebox";
import { type JudgmentContext, judgmentPrompt, type ModelAccess, named, recorded, registered } from "./pi-claimcheck.js";

/**
 * A model's list of the cases the operator's request leaves open: inputs
 * for which someone who made the request could expect more than one result
 * (#397). The agent settles such a case silently, in code and a contract
 * that prove either way, so the receipt lists them for the operator to
 * settle. The list is a model's opinion, never evidence and never a verdict,
 * and it does not go back to the agent. It reads the request alone: shown
 * the agent's change as well, models listed more false alarms. Measured
 * before it shipped, with this prompt (#397). Its two rules on standard
 * terms came from #429, after it listed readings of "clamp" that its usual
 * meaning rules out: a term keeps that meaning, and an input the request
 * allows that the meaning gives no result for stays open, since the first
 * rule alone dropped such inputs, an empty name or a page size of zero.
 */

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

type ListAnswer =
  | { readonly status: "listed"; readonly cases: readonly OpenCase[] }
  | { readonly status: "not_listed"; readonly reason: string };

const listSchema: TSchema = Type.Union([
  Type.Object({ status: Type.Literal("listed"), cases: Type.Array(Type.Object({ input: Type.String(), outcomes: Type.Array(Type.String()) })) }),
  Type.Object({ status: Type.Literal("not_listed"), reason: Type.String({ minLength: 1 }) }),
]);

export const openCasesSystemPrompt =
  "You read requests people give coding agents and find what they leave open. Answer only through the tool you are given.";

/** What the model is asked about the operator's `requests`, every message of one request in order. */
export function openCasesPrompt(requests: readonly string[]): string {
  return `A person gave a coding agent this request:\n\n${requests.join("\n\n")}\n\n` +
    "You can read only these request messages, not external sources or the agent's change. If the request depends on " +
    "an issue, PR, file, URL or other reference whose relevant contents are not supplied in these messages, record " +
    "status not_listed with a reason naming what is missing and why you cannot list its cases. Missing reference contents are not an open case: " +
    "do not guess what they say or invent alternative interpretations of them. A reference mentioned only as background " +
    "does not prevent listing cases when the request itself supplies the requirements. Otherwise record status listed with cases. " +
    "List each input case the request does not settle: an input for which a reasonable person who made the request could " +
    "expect more than one result. A standard term the request names keeps its established meaning unless the request says " +
    "otherwise, and that meaning settles the cases it decides; the request need not restate it. List a case only when two " +
    "different results stay reasonable under that meaning and every rule the request states, never one that needs an " +
    "unusual reading of a term. An input the request allows that neither its words nor that meaning give one result for " +
    "stays open. For each, give the input and the results someone could expect. Leave out cases the " +
    "request settles, and anything about how the code or its proof is written. If the request settles every case, list none. " +
    "Leave out inputs of a kind the request never mentions, such as NaN, Infinity, -0, or values that are not of the type it names.";
}

/** The open cases of `requests`, listed by `model`, a `provider/id` Tesota knows, within `OPEN_CASES_TIME_LIMIT_MS`. */
export async function openCases(ctx: ModelAccess, requests: readonly string[], model: string, signal: AbortSignal, judging?: JudgmentContext): Promise<OpenCases> {
  if (model === "") return { status: "not_listed", reason: "no model is selected" };
  const lister = registered(ctx, model);
  if (lister === undefined) return { status: "not_listed", reason: `${model} isn't a model Tesota knows (provider/id)` };
  const prompt = judgmentPrompt(lister, openCasesSystemPrompt, "record_open_cases", listSchema, requests, openCasesPrompt, "open_cases", judging);
  if (prompt === undefined) return { status: "not_listed", reason: `${model}: no whole request fits the complete prompt within model context capacity` };
  const listed = await recorded<ListAnswer>(ctx, lister, openCasesSystemPrompt, "record_open_cases", listSchema,
    prompt, AbortSignal.any([signal, AbortSignal.timeout(OPEN_CASES_TIME_LIMIT_MS)]));
  if (typeof listed === "string") return { status: "not_listed", reason: `${named(lister)} ${listed}` };
  return listed.status === "not_listed" ? { status: "not_listed", reason: `${named(lister)} ${listed.reason}` }
    : { status: "listed", model: named(lister), cases: listed.cases };
}
