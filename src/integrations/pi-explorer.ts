import { realpathSync } from "node:fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { type ModelAccess, runWithin, startModelSession } from "./model-session.js";
import { type AgentActivity, type CodingTurnResult, readOnlyFileTools, repositoryInstructions } from "./pi-coding-session.js";
import { isExplorerAnswer } from "../verification/explorer-answer.js";

/**
 * An explorer (decision 019): a fresh, read-only Pi session that answers one
 * question the working agent asks, and changes nothing. It sees the brief,
 * never the agent's conversation, and its answer is advice to the agent,
 * never evidence.
 */

/** An explorer stops after this long, answered or not. */
export const EXPLORER_TIME_LIMIT_MS: number = 5 * 60_000;
/** The agent reads at most this much of an explorer's answer. */
export const EXPLORER_ANSWER_LIMIT = 12_000;

export type ExplorerResult =
  | Readonly<{ status: "answered"; answer: string }>
  | Readonly<{ status: "unfinished"; reason: string }>;

export interface ExplorerOptions extends ModelAccess {
  readonly onActivity?: (activity: AgentActivity) => void;
  /** Where the explorer's conversation is saved for the operator; kept in memory when absent. */
  readonly sessionManager?: SessionManager;
  readonly timeLimitMs?: number;
}

export function explorerPrompt(root: string): string {
  return "You are an explorer for Tesota's working agent. The agent gives you one question about a private copy " +
    "of a repository; answer it by investigating with the read, search and list tools. You cannot change " +
    "files or run commands. Read what the question needs and no more. Answer in plain text: first the " +
    "answer, then the files and line numbers you relied on, then what you looked for and did not find. Say " +
    "when something is your inference rather than what the code shows. Do not propose or write changes " +
    "unless the question asks what would need to change." +
    `\n\nPlatform: ${process.platform}.` + repositoryInstructions(root);
}

/** The explorer's answer as the agent reads it, or why there is none; an empty reply is never an answer. */
export function explorerResult(turn: CodingTurnResult, timedOut: boolean, limit: number = EXPLORER_ANSWER_LIMIT): ExplorerResult {
  if (timedOut) return { status: "unfinished", reason: "the explorer ran past its time limit" };
  if (turn.status === "cancelled") return { status: "unfinished", reason: "the explorer was stopped" };
  if (turn.status === "unsettled") return { status: "unfinished", reason: "the explorer could not be stopped cleanly" };
  if (turn.status === "failed") return { status: "unfinished", reason: `the model request failed: ${turn.reason}` };
  const answer = turn.reply.trim();
  if (!isExplorerAnswer(timedOut, turn.status, answer.length)) return { status: "unfinished", reason: "the explorer gave no answer" };
  return { status: "answered", answer: answer.length <= limit ? answer
    : `${answer.slice(0, limit)}\n[The explorer's answer is cut at ${limit} characters.]` };
}

/** Ask one explorer one question; it stops at its time limit or when `signal` aborts. */
export async function askExplorer(options: ExplorerOptions, checkout: string, brief: string,
  signal: AbortSignal): Promise<ExplorerResult> {
  const root = realpathSync(checkout);
  const session = await startModelSession(options, { cwd: root, systemPrompt: explorerPrompt(root), tools: readOnlyFileTools(root),
    ...(options.sessionManager === undefined ? {} : { sessionManager: options.sessionManager }),
    ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }) });
  try {
    const { turn, timedOut } = await runWithin(session, brief, signal, options.timeLimitMs ?? EXPLORER_TIME_LIMIT_MS);
    return explorerResult(turn, timedOut);
  } finally { session.dispose(); }
}
