import { limitedTurnStatus } from "../verification/turn-time-limit.js";

/**
 * What every engine's session provides to a role, whichever engine runs it
 * (decisions 021 and 022). Pi and Claude Code each implement it;
 * `tests/model-session-contract.test.ts` holds both to it.
 */

/**
 * What the agent is doing, as it happens, for a surface to show. `reply`
 * carries the full text of one assistant message so far; `message` numbers
 * the messages of a session in order.
 */
export type AgentActivity =
  | Readonly<{ type: "reply"; message: number; text: string; final: boolean }>
  | Readonly<{ type: "tool_started"; call: string; tool: string; subject: string }>
  | Readonly<{ type: "tool_output"; call: string; output: string }>
  | Readonly<{ type: "tool_finished"; call: string; failed: boolean; output: string; change?: AgentChange }>;

export interface AgentChange {
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly string[];
}

/** How one request to a session ended. */
export type TurnResult =
  | Readonly<{ status: "completed"; reply: string }>
  /** The engine reported a failure; `reason` is its own message. */
  | Readonly<{ status: "failed"; reason: string }>
  | Readonly<{ status: "cancelled" }>
  /** The engine could not be stopped cleanly, and the session is no longer usable. */
  | Readonly<{ status: "unsettled" }>;

export interface ModelSession {
  readonly usable: boolean;
  /** Run one request to completion, cancellation or a confirmed failure. */
  run(request: string, signal: AbortSignal): Promise<TurnResult>;
  dispose(): void;
}

/** How a request run under a time limit ended: as the engine reported, or past its limit. */
export type LimitedTurnResult = TurnResult | Readonly<{ status: "timed_out" }>;

/**
 * A review role's request (reviewer, lens, ClaimCheck, refuter, fix validator)
 * stops after this long, answered or not, so a stalled model cannot hold a
 * review. Measured requests take seconds to two minutes; each engine also
 * guards its own connections, retrying within this limit.
 */
export const REVIEW_TIME_LIMIT_MS: number = 10 * 60_000;

/** Run one request under a time limit; the proved `limitedTurnStatus` decides when it timed out. */
export async function runWithTimeLimit(session: ModelSession, request: string, signal: AbortSignal,
  limitMs: number): Promise<LimitedTurnResult> {
  const limit = AbortSignal.timeout(limitMs);
  const turn = await session.run(request, AbortSignal.any([signal, limit]));
  return limitedTurnStatus(turn.status, limit.aborted, signal.aborted) === "timed_out" ? { status: "timed_out" } : turn;
}
