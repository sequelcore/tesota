import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { Contract } from "./proof-guarantees.js";

/**
 * ClaimCheck's round-trip method (metareflection/claimcheck, MIT), adapted to
 * LemmaScript contracts that proved, run through Pi's model registry. Pass 1
 * restates each contract without seeing the operator's request; pass 2, a
 * separate request, compares that restatement with the request. ClaimCheck
 * uses two different models for the passes; unless a second model is set,
 * both use the session's model, kept apart by context only, and the receipt
 * says so. Its verdict is a model's judgment, never a proof.
 */

/** Both passes together end within this, so a stalled provider cannot hold the run open. */
export const CLAIMCHECK_TIME_LIMIT_MS: number = 5 * 60_000;

const informalizationSchema: TSchema = Type.Object({ informalizations: Type.Array(Type.Object({
  function: Type.Integer({ description: "The function's number in the list" }),
  preconditions: Type.String({ description: "What the requires clauses assume, literally" }),
  postcondition: Type.String({ description: "What the ensures clauses guarantee, literally" }),
  strength: Type.Union([Type.Literal("trivial"), Type.Literal("weak"), Type.Literal("moderate"), Type.Literal("strong")]),
})) });
const comparisonSchema: TSchema = Type.Object({ comparisons: Type.Array(Type.Object({
  function: Type.Integer({ description: "The function's number in the list" }),
  verdict: Type.Union([Type.Literal("justified"), Type.Literal("partially_justified"), Type.Literal("not_justified"),
    Type.Literal("vacuous")]),
  explanation: Type.String(),
})) });

/** Pass 1's literal restatement of one contract, the `function`th in the list. */
export interface Informalization {
  readonly function: number;
  readonly preconditions: string;
  readonly postcondition: string;
  readonly strength: "trivial" | "weak" | "moderate" | "strong";
}

/** Pass 2's judgment of the `function`th contract against the request. */
export interface Comparison {
  readonly function: number;
  readonly verdict: "justified" | "partially_justified" | "not_justified" | "vacuous";
  readonly explanation: string;
}

/**
 * A model's judgment of the contracts against the request, with the models
 * that restated and compared them as `provider/id`; `judgments` follows the
 * order of the contracts judged.
 */
export type ClaimCheck =
  | { readonly status: "judged"; readonly restatedBy: string; readonly comparedBy: string;
    readonly judgments: readonly Pick<Comparison, "verdict" | "explanation">[] }
  | { readonly status: "not_judged"; readonly reason: string };

function contractList(items: readonly Contract[]): string {
  return items.map((item, index) => `### Function ${index + 1}: ${item.name} (${item.path})\n\n\`\`\`typescript\n${item.text}\n\`\`\``).join("\n\n");
}

/** Pass 1. It must never contain the operator's request. */
export function informalizePrompt(items: readonly Contract[]): string {
  return "You are reading LemmaScript function contracts, already proved by Dafny, and translating them to plain " +
    `English.\n\n## Contracts\n\n${contractList(items)}\n\n## Instructions\n\nFor each function contract, describe ` +
    "literally what it guarantees, not what you think the author intended. State the preconditions (requires) and " +
    "postconditions (ensures) separately. Rate the claim's strength: trivial if the ensures restates the requires, " +
    "is always true, or follows from definitions; weak if it says very little; moderate if it makes a substantive " +
    "claim; strong if it significantly constrains behavior. Flag ensures clauses that mirror requires clauses.\n\n" +
    "Call record_informalizations with one entry per function.";
}

/** Pass 2: the request against the restatements, with the contracts for reference. */
export function comparePrompt(requests: readonly string[], items: readonly Contract[],
  informalizations: readonly Informalization[]): string {
  const pairs = items.map((item, index) => {
    const back = informalizations.find((entry) => entry.function === index + 1);
    return `### Function ${index + 1}: ${item.name} (${item.path})\n\n\`\`\`typescript\n${item.text}\n\`\`\`\n\n**Back-translation:**\n` +
      `- Preconditions: ${back?.preconditions ?? "(missing)"}\n- Postcondition: ${back?.postcondition ?? "(missing)"}\n` +
      `- Strength: ${back?.strength ?? "(missing)"}`;
  }).join("\n\n");
  return "You are checking whether proved LemmaScript contracts express what the user asked for. Each " +
    "back-translation was written in a separate session that did not see the user's requests.\n\n" +
    `## The user's requests, verbatim\n\n${requests.map((request, index) => `${index + 1}. ${request}`).join("\n") ||
      "(not recorded)"}\n\n## Contracts\n\n${pairs}\n\n## Watch for\n\n1. Tautology: the ensures restates the requires.\n` +
    "2. Weakened postcondition: the ensures says less than the requests ask.\n3. Narrowed scope: only some of " +
    "the cases the requests describe.\n4. Missing case: the requests have several conditions and the contract " +
    "captures some.\n5. Wrong property: something related but different.\n\nBe strict about quantifiers and boundaries " +
    "(`<` against `<=`), but do not flag different wording with the same meaning. A contract that is not about " +
    "anything the requests mention is justified if it is consistent with them. A trivial back-translation is almost " +
    "always a mismatch.\n\nCall record_comparisons with one entry per function.";
}

/** The judgments in the contracts' order; not judged when a contract was left without a comparison. */
export function claimcheckResult(models: Pick<Extract<ClaimCheck, { status: "judged" }>, "restatedBy" | "comparedBy">,
  items: readonly Contract[], comparisons: readonly Comparison[]): ClaimCheck {
  const judgments = items.map((_item, index) => comparisons.find((comparison) => comparison.function === index + 1));
  const missing = items.filter((_item, index) => judgments[index] === undefined);
  if (missing.length > 0) return { status: "not_judged", reason: `no comparison for ${missing.map((item) => item.name).join(", ")}` };
  return { status: "judged", ...models,
    judgments: judgments.flatMap((judgment) => judgment === undefined ? [] : [{ verdict: judgment.verdict, explanation: judgment.explanation }]) };
}

type ModelAccess = Pick<ExtensionContext, "model" | "modelRegistry">;
type Reply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;

/** Why a reply that ended without an answer ended so. */
function unanswered(reply: Pick<Reply, "stopReason" | "errorMessage">, signal: AbortSignal): string | undefined {
  if (reply.stopReason === "aborted" || signal.aborted) {
    return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "ran past its time limit" : "was stopped";
  }
  return reply.stopReason === "error" ? `the model request failed: ${reply.errorMessage ?? "no reason given"}` : undefined;
}

/** One request to `model`, answered through the tool `name` with `parameters`; why it gave no answer otherwise. */
async function recorded<T>(ctx: ModelAccess, model: NonNullable<ModelAccess["model"]>, name: string,
  parameters: TSchema, prompt: string, signal: AbortSignal): Promise<T | string> {
  let reply: Reply;
  try {
    reply = await ctx.modelRegistry.complete(model, {
      systemPrompt: "You compare formal specifications with natural-language requirements. Answer only through the tool you are given.",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      tools: [{ name, description: "Record your answer. Call it exactly once.", parameters }],
    }, { signal });
  } catch (error) {
    return unanswered({ stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) }, signal) ?? "";
  }
  const why = unanswered(reply, signal);
  if (why !== undefined) return why;
  const call = reply.content.find((part) => part.type === "toolCall" && part.name === name);
  return call?.type === "toolCall" && Value.Check(parameters, call.arguments) ? call.arguments as T : "the model did not record its answer";
}

const named = (model: NonNullable<ModelAccess["model"]>): string => `${model.provider}/${model.id}`;

/**
 * ClaimCheck on `items` against the operator's `requests`. The session's
 * model compares; `restateWith`, a `provider/id` in Pi's model registry,
 * restates when set, as ClaimCheck's method uses a second model for that
 * pass, and the session's model restates otherwise. Not judged when a model
 * is missing, or when a pass gives no usable answer within
 * `CLAIMCHECK_TIME_LIMIT_MS`.
 */
export async function claimCheck(ctx: ModelAccess, requests: readonly string[], items: readonly Contract[],
  signal: AbortSignal, restateWith?: string): Promise<ClaimCheck> {
  const { model } = ctx;
  if (model === undefined) return { status: "not_judged", reason: "no model is selected" };
  const slash = restateWith?.indexOf("/") ?? -1;
  const restater = restateWith === undefined ? model
    : slash > 0 ? ctx.modelRegistry.find(restateWith.slice(0, slash), restateWith.slice(slash + 1)) : undefined;
  if (restater === undefined) {
    return { status: "not_judged", reason: `its restating model ${restateWith ?? ""} is not a provider/id in Pi's model registry` };
  }
  const limited = AbortSignal.any([signal, AbortSignal.timeout(CLAIMCHECK_TIME_LIMIT_MS)]);
  const first = await recorded<{ informalizations: Informalization[] }>(ctx, restater, "record_informalizations",
    informalizationSchema, informalizePrompt(items), limited);
  if (typeof first === "string") return { status: "not_judged", reason: first };
  const second = await recorded<{ comparisons: Comparison[] }>(ctx, model, "record_comparisons", comparisonSchema,
    comparePrompt(requests, items, first.informalizations), limited);
  if (typeof second === "string") return { status: "not_judged", reason: second };
  return claimcheckResult({ restatedBy: named(restater), comparedBy: named(model) }, items, second.comparisons);
}
