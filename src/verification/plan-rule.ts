/**
 * Decision 033's rule for the agent's plan. An update is accepted only when
 * it has between one and twenty steps, at most one of them in progress, and
 * every blocked step says why; anything else is refused whole, and the plan
 * shown stays as it was.
 */
//@ requires steps >= 0 && inProgress >= 0 && unexplainedBlocked >= 0
//@ ensures \result <==> (steps >= 1 && steps <= 20 && inProgress <= 1 && unexplainedBlocked === 0)
export function planAccepted(steps: number, inProgress: number, unexplainedBlocked: number): boolean {
  if (steps < 1 || steps > 20) return false;
  return inProgress <= 1 && unexplainedBlocked === 0;
}
