import type { DecisionModel } from "../model-roles.js";
import { turnCheckable } from "../verification/answer-check-rule.js";
import type { TriageDecision } from "./answer-triage.js";
import { TesotaCredentials } from "./tesota-credentials.js";

/**
 * The answer check's first pass on TypeSafe's Jev (decision 035), a typed
 * decision model that answers in about a tenth of a second, where a model
 * session takes about two. It asks two questions in parallel: what the
 * requests ask for, from the requests alone, so the agent's wording cannot
 * talk a request out of its check; and whether the reply states anything
 * checkable, from the requests and the reply.
 */

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Jev answers in about 0.1 s; one that has not by then counts as undecided, and the full check runs. */
export const JEV_TIME_LIMIT_MS: number = 10_000;

/**
 * A turn is skipped only when Jev gives it less than this probability of
 * being checkable: the threshold registered with the cases before any model
 * saw them, stricter than an even split because a checkable turn skipped
 * could let a false claim pass.
 */
export const JEV_SKIP_BELOW = 0.2;

export type RequestKind = "change" | "repository" | "conversation";

const requestQuestion = {
  type: "choice",
  instructions: "What do the user's requests to a coding agent working on their repository ask for?",
  criteria: {
    change: "To create, change, fix, add, remove or run something, including a short follow-up such as 'do it', " +
      "'continue' or 'also add the test' after such a request.",
    repository: "Information about the repository's code, files or behavior, or about the agent's work on it.",
    conversation: "Only greetings, thanks, small talk, opinions, or questions that do not concern the repository.",
  } satisfies Record<RequestKind, string>,
};

const claimsQuestion = {
  type: "noul",
  instructions: "Does the coding agent's reply state something that can be checked?",
  criteria: {
    true: "The reply states facts about the repository's code, files, behavior or pending changes, or says what the " +
      "agent read, ran, checked or changed.",
    false: "The reply only greets, thanks, asks what to do, or gives an opinion.",
  },
};

/** What Jev is asked: the request's kind from the requests alone, and the reply's claims from both. */
export function jevRequests(model: DecisionModel, requests: readonly string[], reply: string):
  Readonly<{ request: object; claims: object }> {
  const pinned = model.slice(model.indexOf(":") + 1);
  return {
    request: { model: pinned, state: { user_requests: [...requests] }, questions: { request: requestQuestion } },
    claims: { model: pinned, state: { user_requests: [...requests], agent_reply: reply.trim() || "(empty)" },
      questions: { claims: claimsQuestion } },
  };
}

const probabilityIn = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
const field = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => typeof current === "object" && current !== null ? Reflect.get(current, key) : undefined, value);

/**
 * Jev's two answers as one decision (`turnCheckable`): the turn is skipped
 * only when both the probability that the requests ask for more than
 * conversation and the probability that the reply claims something fall
 * below the threshold; the larger is kept as the turn's probability, and
 * anything but probabilities between 0 and 1 is no decision.
 */
export function jevDecision(requestBody: unknown, claimsBody: unknown): TriageDecision {
  const conversation = probabilityIn(field(requestBody, "answers", "request", "probabilities", "conversation"));
  const claims = probabilityIn(field(claimsBody, "answers", "claims", "noul"));
  if (conversation === undefined || claims === undefined) return { decided: false, checkable: true, reason: "Jev gave no probability" };
  // Compared on the conversation side, so 1 - 0.8 rounding below 0.2 cannot skip a turn at the threshold.
  const checkable = turnCheckable(conversation <= 1 - JEV_SKIP_BELOW, claims >= JEV_SKIP_BELOW);
  return { decided: true, checkable, probability: Math.max(1 - conversation, claims),
    reason: `Jev: requests ${(1 - conversation).toFixed(2)} beyond conversation, reply ${claims.toFixed(2)} checkable` };
}

export async function jevTriage(key: string, model: DecisionModel, requests: readonly string[], reply: string,
  signal: AbortSignal, timeLimitMs: number = JEV_TIME_LIMIT_MS, request: typeof fetch = fetch): Promise<TriageDecision> {
  const bodies = jevRequests(model, requests, reply);
  const limit = AbortSignal.any([signal, AbortSignal.timeout(timeLimitMs)]);
  const ask = async (body: object): Promise<unknown> => {
    const response = await request(ENDPOINT, { method: "POST", signal: limit,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Jev answered HTTP ${response.status}`);
    return await response.json();
  };
  try {
    const [requestBody, claimsBody] = await Promise.all([ask(bodies.request), ask(bodies.claims)]);
    return jevDecision(requestBody, claimsBody);
  } catch (error) {
    const reason = error instanceof Error && error.message.startsWith("Jev answered") ? error.message : "Jev could not be reached";
    return { decided: false, checkable: true, reason };
  }
}

/** The operator's TypeSafe key: the one `tesota auth login typesafe` saved, or else `TYPESAFE_API_KEY`. */
export async function typesafeKey(credentials: TesotaCredentials = new TesotaCredentials(),
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<string | undefined> {
  const saved = await credentials.read("typesafe");
  const stored = saved?.type === "api_key" ? saved.key?.trim() : undefined;
  if (stored !== undefined && stored !== "") return stored;
  const ambient = environment["TYPESAFE_API_KEY"]?.trim();
  return ambient === undefined || ambient === "" ? undefined : ambient;
}
