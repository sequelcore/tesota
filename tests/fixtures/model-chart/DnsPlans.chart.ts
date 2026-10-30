/** How the model graph reads DnsPlans' states and steps: the planner, two enactors and two endpoints. */
interface Values {
  readonly plans: readonly number[];
  readonly published: number;
  readonly active: readonly number[];
  readonly pending: readonly number[];
  readonly cursor: readonly number[];
  readonly highWater: readonly number[];
}

export function state(v: Values): string {
  if (v.active.some((plan, at) => plan < (v.highWater[at] ?? 0))) return "an endpoint went back to an older plan";
  if (v.active.some((plan) => plan !== 0 && !v.plans.includes(plan))) return "an endpoint serves a deleted plan";
  const serving = v.active.some((plan) => plan !== 0);
  const applying = v.pending.some((plan) => plan !== 0);
  if (!serving) return applying ? "an enactor holds a plan; nothing served yet" : "nothing served yet";
  return applying ? "endpoints serve plans; an enactor is applying one" : "endpoints serve plans; enactors idle";
}

const enactor = (before: Values, after: Values): number =>
  [0, 1].find((at) => before.pending[at] !== after.pending[at] || before.cursor[at] !== after.cursor[at]) ?? 0;

export function step(action: string, before: Values, after: Values): string {
  const e = enactor(before, after);
  const name = `enactor ${e + 1}`;
  if (action === "Publish") return `the planner publishes plan ${after.published}`;
  if (action === "Select") return `${name} picks plan ${after.pending[e] ?? 0}`;
  if (action === "Cleanup") return `${name} deletes old plans`;
  if (action === "Abort") return `${name} gives up`;
  const endpoint = before.cursor[e] ?? 1;
  return before.active[endpoint - 1] === after.active[endpoint - 1]
    ? `${name} skips endpoint ${endpoint}`
    : `${name} writes plan ${after.active[endpoint - 1] ?? 0} to endpoint ${endpoint}`;
}
