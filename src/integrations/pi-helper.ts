import { realpathSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { type AgentActivity, type CodingTurnResult, CodingSession, type ModelAccess, readOnlyFileTools,
  repositoryInstructions, usageOption } from "./pi-coding-session.js";
import { isHelperAnswer } from "../verification/helper-answer.js";

/**
 * A helper (decision 019): a fresh, read-only Pi session that answers one
 * question the working agent asks, and changes nothing. It sees the brief,
 * never the agent's conversation, and its answer is advice to the agent,
 * never evidence.
 */

/** A helper stops after this long, answered or not. */
export const HELPER_TIME_LIMIT_MS: number = 5 * 60_000;
/** The agent reads at most this much of a helper's answer. */
export const HELPER_ANSWER_LIMIT = 12_000;

export type HelperResult =
  | Readonly<{ status: "answered"; answer: string }>
  | Readonly<{ status: "unfinished"; reason: string }>;

export interface HelperOptions extends ModelAccess {
  readonly onActivity?: (activity: AgentActivity) => void;
  /** Where the helper's conversation is saved for the operator; kept in memory when absent. */
  readonly sessionManager?: SessionManager;
  readonly timeLimitMs?: number;
}

export function helperPrompt(root: string): string {
  return "You are a helper for Tesota's working agent. The agent gives you one question about a private copy " +
    "of a repository; answer it by investigating with the read, search and list tools. You cannot change " +
    "files or run commands. Read what the question needs and no more. Answer in plain text: first the " +
    "answer, then the files and line numbers you relied on, then what you looked for and did not find. Say " +
    "when something is your inference rather than what the code shows. Do not propose or write changes " +
    "unless the question asks what would need to change." +
    `\n\nPlatform: ${process.platform}.` + repositoryInstructions(root);
}

/** The helper's answer as the agent reads it, or why there is none; an empty reply is never an answer. */
export function helperResult(turn: CodingTurnResult, timedOut: boolean, limit: number = HELPER_ANSWER_LIMIT): HelperResult {
  if (timedOut) return { status: "unfinished", reason: "the helper ran past its time limit" };
  if (turn.status === "cancelled") return { status: "unfinished", reason: "the helper was stopped" };
  if (turn.status === "unsettled") return { status: "unfinished", reason: "the helper could not be stopped cleanly" };
  if (turn.status === "failed") return { status: "unfinished", reason: `the model request failed: ${turn.reason}` };
  const answer = turn.reply.trim();
  if (!isHelperAnswer(timedOut, turn.status, answer.length)) return { status: "unfinished", reason: "the helper gave no answer" };
  return { status: "answered", answer: answer.length <= limit ? answer
    : `${answer.slice(0, limit)}\n[The helper's answer is cut at ${limit} characters.]` };
}

/** Ask one helper one question; it stops at its time limit or when `signal` aborts. */
export async function askHelper(options: HelperOptions, checkout: string, brief: string,
  signal: AbortSignal): Promise<HelperResult> {
  const root = realpathSync(checkout);
  const limit = AbortSignal.timeout(options.timeLimitMs ?? HELPER_TIME_LIMIT_MS);
  const session = await CodingSession.start({ cwd: root, modelRuntime: options.modelRuntime, model: options.model,
    systemPrompt: helperPrompt(root), tools: readOnlyFileTools(root), ...usageOption(options),
    ...(options.sessionManager === undefined ? {} : { sessionManager: options.sessionManager }),
    ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }) });
  try {
    const turn = await session.run(brief, AbortSignal.any([signal, limit]));
    return helperResult(turn, limit.aborted && !signal.aborted);
  } finally { session.dispose(); }
}
