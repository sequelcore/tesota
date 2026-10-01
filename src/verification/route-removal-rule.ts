/**
 * What becomes of an added route when the operator signs it in, out, or
 * removes it: signing in or out keeps the route and the roles on it, so
 * changing an account never changes the team; removing deletes it, and is
 * refused while a role uses it, so no role is left on a route that is gone.
 */

export type RouteAction = "login" | "logout" | "remove";
export type RouteOutcome = "keep" | "delete" | "refuse";

//@ ensures \result === "keep" <==> action !== "remove"
//@ ensures \result === "refuse" <==> (action === "remove" && inUse)
//@ ensures \result === "delete" <==> (action === "remove" && !inUse)
export function routeAfter(action: RouteAction, inUse: boolean): RouteOutcome {
  if (action !== "remove") return "keep";
  return inUse ? "refuse" : "delete";
}
