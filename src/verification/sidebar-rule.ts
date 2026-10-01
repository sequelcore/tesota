export type SidebarPreference = "auto" | "open" | "hidden";
export type SidebarPresentation = "inline" | "overlay" | "hidden";
export type SidebarProgressPhase = "none" | "preparing" | "working" | "awaiting_command" | "checking" |
  "reviewing" | "awaiting_decision" | "applying";
export type SidebarSessionState = "unresolved" | "ended" | "needs_operator" | Exclude<SidebarProgressPhase, "none"> |
  "unread" | "idle";

export const SIDEBAR_INLINE_MIN_WIDTH = 88;

/**
 * The session sidebar is automatic only when it fits beside the transcript.
 * An explicit open remains reachable as an overlay on a narrow terminal, and
 * an explicit hide always wins.
 */
//@ ensures preference === "hidden" ==> \result === "hidden"
//@ ensures preference !== "hidden" && width >= 88 ==> \result === "inline"
//@ ensures preference === "open" && width < 88 ==> \result === "overlay"
//@ ensures preference === "auto" && width < 88 ==> \result === "hidden"
export function sidebarPresentation(preference: SidebarPreference, width: number): SidebarPresentation {
  if (preference === "hidden") return "hidden";
  if (width >= SIDEBAR_INLINE_MIN_WIDTH) return "inline";
  return preference === "open" ? "overlay" : "hidden";
}

/**
 * One session's state in the navigation rail. Irrecoverable and completed
 * session states outrank stale activity, known approval and decision phases
 * retain their precise meaning, and unread is shown only when no stronger
 * state remains.
 */
//@ ensures blocked ==> \result === "unresolved"
//@ ensures !blocked && ended ==> \result === "ended"
//@ ensures !blocked && !ended && phase === "awaiting_command" ==> \result === "awaiting_command"
//@ ensures !blocked && !ended && phase === "awaiting_decision" ==> \result === "awaiting_decision"
//@ ensures !blocked && !ended && phase !== "awaiting_command" && phase !== "awaiting_decision" && needsOperator ==> \result === "needs_operator"
//@ ensures !blocked && !ended && !needsOperator && phase === "preparing" ==> \result === "preparing"
//@ ensures !blocked && !ended && !needsOperator && phase === "working" ==> \result === "working"
//@ ensures !blocked && !ended && !needsOperator && phase === "checking" ==> \result === "checking"
//@ ensures !blocked && !ended && !needsOperator && phase === "reviewing" ==> \result === "reviewing"
//@ ensures !blocked && !ended && !needsOperator && phase === "applying" ==> \result === "applying"
//@ ensures !blocked && !ended && !needsOperator && phase === "none" && unread ==> \result === "unread"
//@ ensures !blocked && !ended && !needsOperator && phase === "none" && !unread ==> \result === "idle"
export function sidebarSessionState(blocked: boolean, ended: boolean, needsOperator: boolean,
  phase: SidebarProgressPhase, unread: boolean): SidebarSessionState {
  if (blocked) return "unresolved";
  if (ended) return "ended";
  if (phase === "awaiting_command") return "awaiting_command";
  if (phase === "awaiting_decision") return "awaiting_decision";
  if (needsOperator) return "needs_operator";
  if (phase === "preparing") return "preparing";
  if (phase === "working") return "working";
  if (phase === "checking") return "checking";
  if (phase === "reviewing") return "reviewing";
  if (phase === "applying") return "applying";
  return unread ? "unread" : "idle";
}

/** Only states that mean work is presently executing move. Waiting and terminal states remain still. */
//@ ensures \result === (state === "preparing" || state === "working" || state === "checking" || state === "reviewing" || state === "applying")
export function animatedSidebarState(state: SidebarSessionState): boolean {
  return state === "preparing" || state === "working" || state === "checking" || state === "reviewing" ||
    state === "applying";
}

/** States in which a session cannot go on without the operator. */
//@ ensures \result === (state === "unresolved" || state === "needs_operator" || state === "awaiting_command" || state === "awaiting_decision")
export function attentionSidebarState(state: SidebarSessionState): boolean {
  return state === "unresolved" || state === "needs_operator" || state === "awaiting_command" ||
    state === "awaiting_decision";
}

/**
 * The sidebar's group for a session: those that wait on the operator come
 * first (0), the rest after (1). A stable sort on this rank keeps newest-first
 * order within each group.
 */
//@ ensures attentionSidebarState(state) ==> \result === 0
//@ ensures !attentionSidebarState(state) ==> \result === 1
export function sidebarGroupRank(state: SidebarSessionState): number {
  return attentionSidebarState(state) ? 0 : 1;
}

/**
 * The footer names how many sessions wait on the operator only while the
 * sidebar is hidden, which is when their marks cannot be seen, and only if
 * some wait.
 */
//@ ensures \result === (presentation === "hidden" && waiting > 0)
export function showWaitingInFooter(presentation: SidebarPresentation, waiting: number): boolean {
  return presentation === "hidden" && waiting > 0;
}

export type TerminalTitleMark = "attention" | "working" | "selected";

/**
 * The terminal title's mark speaks for every session, since a tab is seen
 * from elsewhere: any session waiting on the operator outranks work in
 * progress anywhere, and only when neither holds does the selected session's
 * own state show.
 */
//@ ensures waiting > 0 ==> \result === "attention"
//@ ensures waiting <= 0 && working > 0 ==> \result === "working"
//@ ensures waiting <= 0 && working <= 0 ==> \result === "selected"
export function terminalTitleMark(waiting: number, working: number): TerminalTitleMark {
  if (waiting > 0) return "attention";
  return working > 0 ? "working" : "selected";
}

/**
 * How many sessions other than the selected one wait on the operator, which
 * the title names so its mark is never taken for the selected session's.
 */
//@ requires waiting >= 0
//@ requires !selectedWaiting || waiting >= 1
//@ ensures \result >= 0
//@ ensures selectedWaiting ==> \result === waiting - 1
//@ ensures !selectedWaiting ==> \result === waiting
export function otherSessionsWaiting(waiting: number, selectedWaiting: boolean): number {
  return selectedWaiting ? waiting - 1 : waiting;
}

/** Map a newest-first visual position to the insertion-ordered session list; invalid positions have no index. */
//@ ensures count <= 0 || visual < 0 || visual >= count ==> \result === -1
//@ ensures count > 0 && visual >= 0 && visual < count ==> \result === count - visual - 1
export function newestFirstSourceIndex(count: number, visual: number): number {
  if (count <= 0 || visual < 0 || visual >= count) return -1;
  return count - visual - 1;
}
