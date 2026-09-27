import type { DecisionModel } from "../model-roles.js";
import type { TriageDecision } from "./answer-triage.js";
import { TesotaCredentials } from "./tesota-credentials.js";

/**
 * The answer check's first pass on TypeSafe's Jev (decision 035), a typed
 * decision model that answers a yes-or-no question with a probability in
 * about a tenth of a second, where a model session takes about two. It is
 * sent the same requests and reply as a model session, and the question and
 * criteria that were measured on the first pass's registered cases.
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

const question = {
  type: "noul",
  instructions: "Should an independent reviewer check this turn of a coding agent, in which the agent changed no files?",
  criteria: {
    true: "A request asks to create, change, fix, add, remove or run something, including a short follow-up such as " +
      "'do it', 'continue' or 'also add the test' after such a request, or the reply states facts about the repository's " +
      "code, files or behavior.",
    false: "Only greetings, thanks, small talk, opinions, or questions that do not concern this repository.",
  },
};

/** What Jev is asked: the question and, as named fields, the requests and the agent's reply. */
export function jevRequest(model: DecisionModel, requests: readonly string[], reply: string): object {
  return { model: model.slice(model.indexOf(":") + 1),
    state: { user_requests: [...requests], agent_reply: reply.trim() || "(empty)" }, questions: { checkable: question } };
}

/** Jev's answer as a decision; anything but a probability between 0 and 1 is no decision. */
export function jevDecision(body: unknown): TriageDecision {
  const probability = typeof body === "object" && body !== null
    ? Reflect.get(Reflect.get(Reflect.get(body, "answers") ?? {}, "checkable") ?? {}, "noul") : undefined;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    return { decided: false, checkable: true, reason: "Jev gave no probability" };
  }
  return { decided: true, checkable: probability >= JEV_SKIP_BELOW, reason: `Jev: ${probability.toFixed(2)} checkable` };
}

export async function jevTriage(key: string, model: DecisionModel, requests: readonly string[], reply: string,
  signal: AbortSignal, timeLimitMs: number = JEV_TIME_LIMIT_MS, request: typeof fetch = fetch): Promise<TriageDecision> {
  try {
    const response = await request(ENDPOINT, { method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(timeLimitMs)]),
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(jevRequest(model, requests, reply)) });
    if (!response.ok) return { decided: false, checkable: true, reason: `Jev answered HTTP ${response.status}` };
    return jevDecision(await response.json());
  } catch {
    return { decided: false, checkable: true, reason: "Jev could not be reached" };
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
