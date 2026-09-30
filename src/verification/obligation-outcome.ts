export type ObligationStatus = "met" | "partial" | "unmet" | "uncertain";
/** The refuter's standing for a gap; `untested` when it never tested one, as for an obligation the reviewer found met. */
export type ObligationStanding = "confirmed" | "refuted" | "unsettled" | "untested";
export type ObligationOutcome = "held" | "not_held" | "uncertain";

/**
 * Decision 034's rule for one obligation, drawn from a request or from a plan
 * step the agent marked done. It held when the reviewer found it met, or
 * found a gap the refuter then disproved; it did not hold only when the
 * refuter confirmed a gap the reviewer found; anything else, including a gap
 * nobody tested or settled, is uncertain and left to the person, never sent
 * back and never cleared.
 */
//@ ensures (\result === "not_held") <==> ((status === "partial" || status === "unmet") && standing === "confirmed")
//@ ensures (\result === "held") <==> (status === "met" || ((status === "partial" || status === "unmet") && standing === "refuted"))
export function obligationOutcome(status: ObligationStatus, standing: ObligationStanding): ObligationOutcome {
  if (status === "met") return "held";
  if (status === "uncertain") return "uncertain";
  if (standing === "confirmed") return "not_held";
  return standing === "refuted" ? "held" : "uncertain";
}
