import type { ExtensionContext } from "./contract.js";
import { type TSchema, Type } from "typebox";
import type { Contract } from "./proof-guarantees.js";
import type { RequestJudgment } from "./receipt.js";
import { contextUsage } from "./context-usage.js";
import { fitsContext } from "./verification/request-context-rule.js";

/**
 * ClaimCheck's round-trip method (metareflection/claimcheck, MIT), adapted to
 * LemmaScript contracts that proved, run through pi-ai's model registry. Pass 1
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

export type ModelAccess = Pick<ExtensionContext, "model" | "modelRegistry">;
/** Whole operator requests, and where the gate records the context each judge actually received. */
export interface JudgmentContext {
  readonly folder?: string;
  readonly requests: RequestJudgment["requests"];
  readonly record: (judgment: RequestJudgment) => void;
}

type Reply = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;

/** Why a reply that ended without an answer ended so. */
function unanswered(reply: Pick<Reply, "stopReason" | "errorMessage">, signal: AbortSignal): string | undefined {
  if (reply.stopReason === "aborted" || signal.aborted) {
    return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "ran past its time limit" : "was stopped";
  }
  return reply.stopReason === "error" ? `the model request failed: ${reply.errorMessage ?? "no reason given"}` : undefined;
}

const comparing = "You compare formal specifications with natural-language requirements. Answer only through the tool you are given.";

const answerTool = (name: string, parameters: TSchema) => ({ name, description: "Record your answer. Call it exactly once.", parameters });

/** Estimate the complete input with the engine's context rules, reserving the model's maximum output. */
function promptFits(model: NonNullable<ModelAccess["model"]>, system: string, name: string, parameters: TSchema, prompt: string): boolean {
  const usage = contextUsage([{ role: "user", content: prompt, timestamp: 0 }], system, [answerTool(name, parameters)], model.contextWindow);
  return usage?.tokens != null && fitsContext(usage.tokens, model.maxTokens, usage.contextWindow);
}

/** The newest contiguous suffix of whole requests that fits the complete prompt; never truncate one request's requirements. */
export function judgmentPrompt(model: NonNullable<ModelAccess["model"]>, system: string, name: string, parameters: TSchema,
  requests: readonly string[], build: (texts: readonly string[]) => string, method: RequestJudgment["method"], judging?: JudgmentContext): string | undefined {
  const groups = judging?.requests ?? requests.map((text, index) => ({ run: index + 1, text: [text] }));
  let from = groups.length;
  let prompt: string | undefined;
  while (from > 0) {
    const candidate = build(groups.slice(from - 1).flatMap(({ text }) => text));
    if (!promptFits(model, system, name, parameters, candidate)) break;
    prompt = candidate;
    from -= 1;
  }
  // No request is meaningful too: direct callers can have no saved operator input.
  if (groups.length === 0 && promptFits(model, system, name, parameters, build([]))) prompt = build([]);
  judging?.record({ method, folder: judging.folder ?? "", requests: groups.slice(from), omitted: groups.slice(0, from).map(({ run }) => run) });
  return prompt;
}

/** One request to `model` with `systemPrompt`, answered through the tool `name` with `parameters`; why it gave no answer otherwise. */
export async function recorded<T>(ctx: ModelAccess, model: NonNullable<ModelAccess["model"]>, systemPrompt: string, name: string,
  parameters: TSchema, prompt: string, signal: AbortSignal): Promise<T | string> {
  if (!promptFits(model, systemPrompt, name, parameters, prompt)) return "the complete prompt exceeds or has no known model context capacity";
  let reply: Reply;
  try {
    reply = await ctx.modelRegistry.complete(model, {
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      tools: [answerTool(name, parameters)],
    }, { signal });
  } catch (error) {
    return unanswered({ stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) }, signal) ?? "";
  }
  const why = unanswered(reply, signal);
  if (why !== undefined) return why;
  const call = reply.content.find((part) => part.type === "toolCall" && part.name === name);
  // TypeBox's checker takes about 100 ms and 24 MB to load, so it loads when a model first answers, not with Tesota (#446).
  const { Value } = await import("typebox/value");
  return call?.type === "toolCall" && Value.Check(parameters, call.arguments) ? call.arguments as T : "the model did not record its answer";
}

export const named = (model: NonNullable<ModelAccess["model"]>): string => `${model.provider}/${model.id}`;

/** The model `name`, a `provider/id`, in pi-ai's model registry; undefined when it is not one. */
export function registered(ctx: ModelAccess, name: string): ModelAccess["model"] {
  const slash = name.indexOf("/");
  return slash > 0 ? ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1)) : undefined;
}

/**
 * ClaimCheck on `items` against the operator's `requests`. The session's
 * model compares; `restateWith`, a `provider/id` in pi-ai's model registry,
 * restates when set, as ClaimCheck's method uses a second model for that
 * pass, and the session's model restates otherwise. Not judged when a model
 * is missing, or when a pass gives no usable answer within
 * `CLAIMCHECK_TIME_LIMIT_MS`.
 */
export async function claimCheck(ctx: ModelAccess, requests: readonly string[], items: readonly Contract[],
  signal: AbortSignal, restateWith?: string, judging?: JudgmentContext): Promise<ClaimCheck> {
  const { model } = ctx;
  if (model === undefined) return { status: "not_judged", reason: "no model is selected" };
  const restater = restateWith === undefined ? model : registered(ctx, restateWith);
  if (restater === undefined) {
    return { status: "not_judged", reason: `its restating model ${restateWith ?? ""} isn't a model Tesota knows (provider/id)` };
  }
  const limited = AbortSignal.any([signal, AbortSignal.timeout(CLAIMCHECK_TIME_LIMIT_MS)]);
  const first = await recorded<{ informalizations: Informalization[] }>(ctx, restater, comparing, "record_informalizations",
    informalizationSchema, informalizePrompt(items), limited);
  if (typeof first === "string") return { status: "not_judged", reason: `${named(restater)} ${first}` };
  const prompt = judgmentPrompt(model, comparing, "record_comparisons", comparisonSchema, requests,
    (texts) => comparePrompt(texts, items, first.informalizations), "claimcheck", judging);
  if (prompt === undefined) return { status: "not_judged", reason: "no whole request fits the complete prompt within model context capacity" };
  const second = await recorded<{ comparisons: Comparison[] }>(ctx, model, comparing, "record_comparisons", comparisonSchema,
    prompt, limited);
  if (typeof second === "string") return { status: "not_judged", reason: `${named(model)} ${second}` };
  return claimcheckResult({ restatedBy: named(restater), comparedBy: named(model) }, items, second.comparisons);
}
