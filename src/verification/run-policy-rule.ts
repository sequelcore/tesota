/**
 * What `tesota run` answers where nobody is at the keyboard. A command that
 * asks for approval runs, and a destination the sandbox refused or a site the
 * agent would read is reached, only when the run's own flag allows it, and
 * then for this run alone: a run never saves a rule for later commands and
 * never allows a destination for the repository.
 */

export type RunCommandAnswer = "once" | "rule" | "deny";
export type RunNetworkAnswer = "session" | "repository" | "deny";

//@ ensures \result !== "rule"
//@ ensures (\result === "once") === allowed
export function runCommandAnswer(allowed: boolean): RunCommandAnswer {
  return allowed ? "once" : "deny";
}

//@ ensures \result !== "repository"
//@ ensures (\result === "session") === allowed
export function runNetworkAnswer(allowed: boolean): RunNetworkAnswer {
  return allowed ? "session" : "deny";
}

/** How a run's turn ended, before it started or after. */
export type RunStatus = "not_started" | "completed" | "failed" | "cancelled" | "unsettled";

/**
 * A run's exit code: 0 only when the turn completed and the loop ended
 * cleanly with nothing left for `tesota recover`; 130 when it was stopped;
 * 1 otherwise.
 */
//@ ensures (\result === 0) === (status === "completed" && !blocked && loop === 0)
//@ ensures (\result === 130) === (status === "cancelled" && !blocked && loop === 0)
//@ ensures \result === 0 || \result === 1 || \result === 130
export function runExitCode(status: RunStatus, blocked: boolean, loop: number): number {
  if (blocked || loop !== 0) return 1;
  if (status === "completed") return 0;
  return status === "cancelled" ? 130 : 1;
}
