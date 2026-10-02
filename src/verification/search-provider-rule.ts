/**
 * Which web search provider answers (issue #295). A provider the operator
 * pinned in `~/.tesota/web.json` is the only one used: unavailable, the
 * search fails rather than reaching a provider the operator did not pick, and
 * a failed search never moves on to another. Without a pin, each provider in
 * order is used when it is available, and a failure moves on to the next.
 *
 * No new recipient without the operator's choice: a keyless provider, which
 * receives the search's words without any account of the operator's, is used
 * only once the operator allowed keyless search or pinned that provider; until
 * the operator has answered, the search asks.
 */

export type SearchStep = "use" | "skip" | "fail" | "ask";
export type SearchConsent = "allowed" | "denied" | "unasked";

//@ ensures pinned && !isPinned ==> \result === "skip"
//@ ensures \result === "use" ==> available && (!pinned || isPinned)
//@ ensures \result === "use" && keyless ==> isPinned || consent === "allowed"
//@ ensures \result === "ask" ==> keyless && !pinned && available && consent === "unasked"
//@ ensures \result === "fail" ==> pinned && isPinned && !available
//@ ensures pinned && isPinned ==> (\result === "use" <==> available)
//@ ensures !pinned && !keyless ==> (\result === "use" <==> available)
//@ ensures !pinned && keyless && available && consent === "allowed" ==> \result === "use"
//@ ensures !pinned && keyless && consent === "denied" ==> \result === "skip"
export function searchStep(pinned: boolean, isPinned: boolean, available: boolean, keyless: boolean,
  consent: SearchConsent): SearchStep {
  if (pinned && !isPinned) return "skip";
  if (!available) return pinned ? "fail" : "skip";
  if (pinned || !keyless || consent === "allowed") return "use";
  return consent === "unasked" ? "ask" : "skip";
}

//@ ensures \result <==> !pinned
export function searchContinues(pinned: boolean): boolean {
  return !pinned;
}
