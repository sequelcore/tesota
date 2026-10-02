/**
 * Which web search provider answers (issue #295). A provider the operator
 * pinned in `~/.tesota/web.json` is the only one used: unavailable, the
 * search fails rather than reaching a provider the operator did not pick, and
 * a failed search never moves on to another. Without a pin, each provider in
 * order is used when it is available, and a failure moves on to the next.
 */

export type SearchStep = "use" | "skip" | "fail";

//@ ensures pinned && !isPinned ==> \result === "skip"
//@ ensures pinned && isPinned ==> (\result === "use" <==> available)
//@ ensures pinned && isPinned ==> (\result === "fail" <==> !available)
//@ ensures !pinned ==> (\result === "use" <==> available)
//@ ensures !pinned ==> (\result === "skip" <==> !available)
export function searchStep(pinned: boolean, isPinned: boolean, available: boolean): SearchStep {
  if (pinned && !isPinned) return "skip";
  if (available) return "use";
  return pinned ? "fail" : "skip";
}

//@ ensures \result <==> !pinned
export function searchContinues(pinned: boolean): boolean {
  return !pinned;
}
