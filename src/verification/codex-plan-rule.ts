/**
 * Whether a ChatGPT route offers a model: a route signed in to a free ChatGPT
 * plan does not offer a model that plan refuses (#296). A route
 * whose plan is unknown, or a paid one, offers every model, since only an
 * observed refusal takes one away.
 */

//@ ensures \result <==> !(onFreePlan && refusedOnFree)
export function planServes(onFreePlan: boolean, refusedOnFree: boolean): boolean {
  return !(onFreePlan && refusedOnFree);
}
