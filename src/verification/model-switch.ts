export type ModelSwitch = "unchanged" | "in_place" | "new_conversation";

/**
 * Decision 026's switch rule. Changing the agent's model keeps its
 * conversation exactly when the new model runs on the same engine; another
 * engine cannot read the conversation, so the agent starts a new one. Asking
 * for the model already in use changes nothing.
 */
//@ ensures sameModel ==> \result === "unchanged"
//@ ensures !sameModel && sameEngine ==> \result === "in_place"
//@ ensures !sameModel && !sameEngine ==> \result === "new_conversation"
export function modelSwitch(sameModel: boolean, sameEngine: boolean): ModelSwitch {
  if (sameModel) return "unchanged";
  return sameEngine ? "in_place" : "new_conversation";
}

/**
 * Decision 026's brief rule. An agent that starts a new conversation in a
 * session with recorded history gets Tesota's brief of it, whatever started
 * the conversation, so a new conversation never begins blank behind an old
 * transcript; one that continues its conversation needs none.
 */
//@ ensures \result <==> (!resumed && hasHistory)
export function needsBrief(resumed: boolean, hasHistory: boolean): boolean {
  return !resumed && hasHistory;
}
