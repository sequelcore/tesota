export type DirectConnection = "blocked" | "connected" | "indeterminate";

/**
 * Decision 043's rule for the `network_direct` control, which connects to a
 * refused destination's address from inside an environment, ignoring its
 * proxy. A connection that opened is `connected`, whatever happened after,
 * since the destination or something on its way received it. A refusal
 * inside counts as `blocked` only when this computer itself connected to the
 * same address, so the refusal came from the environment rather than from the
 * destination or this computer's own network; anything else shows nothing
 * and is `indeterminate`. Only `blocked` passes the control.
 */
//@ ensures \result === "connected" <==> connectedInside
//@ ensures \result === "blocked" <==> (!connectedInside && refusedInside && connectedFromHost)
export function directConnection(connectedInside: boolean, refusedInside: boolean, connectedFromHost: boolean): DirectConnection {
  if (connectedInside) return "connected";
  if (refusedInside && connectedFromHost) return "blocked";
  return "indeterminate";
}
