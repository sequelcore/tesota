/** How freely the agent may act (#449): only read, ask before anything else, or act without asking. */
export type Mode = "read" | "ask" | "full";

/** What a tool call does: only reads, writes or edits files, or runs something. */
export type Access = "read" | "write" | "run";

/** The strongest of the rules that match a call, `unmatched` when none does. */
export type RuleVerdict = "allow" | "ask" | "deny" | "unmatched";

export type Decision = "allow" | "ask" | "deny";

/**
 * The strongest verdict among the rules that match a call (#449): a deny
 * wins over an ask, which wins over an allow, so one rule can never loosen
 * what another tightens.
 */
//@ ensures \result === "deny" <==> exists(k: nat, k < matched.length && matched[k] === "deny")
//@ ensures \result === "ask" <==> !exists(k: nat, k < matched.length && matched[k] === "deny") && exists(k: nat, k < matched.length && matched[k] === "ask")
//@ ensures \result === "allow" <==> !exists(k: nat, k < matched.length && (matched[k] === "deny" || matched[k] === "ask")) && exists(k: nat, k < matched.length && matched[k] === "allow")
//@ ensures \result === "unmatched" <==> !exists(k: nat, k < matched.length && (matched[k] === "deny" || matched[k] === "ask" || matched[k] === "allow"))
export function strongest(matched: readonly RuleVerdict[]): RuleVerdict {
  let found: RuleVerdict = "unmatched";
  let k = 0;
  while (k < matched.length) {
    //@ invariant 0 <= k && k <= matched.length
    //@ invariant found === "deny" <==> exists(j: nat, j < k && matched[j] === "deny")
    //@ invariant found === "ask" <==> !exists(j: nat, j < k && matched[j] === "deny") && exists(j: nat, j < k && matched[j] === "ask")
    //@ invariant found === "allow" <==> !exists(j: nat, j < k && (matched[j] === "deny" || matched[j] === "ask")) && exists(j: nat, j < k && matched[j] === "allow")
    //@ invariant found === "unmatched" <==> !exists(j: nat, j < k && (matched[j] === "deny" || matched[j] === "ask" || matched[j] === "allow"))
    if (matched[k] === "deny") found = "deny";
    else if (matched[k] === "ask" && found !== "deny") found = "ask";
    else if (matched[k] === "allow" && found === "unmatched") found = "allow";
    k = k + 1;
  }
  return found;
}

/**
 * Whether a tool call may run (#449). The floor refuses what no mode
 * allows; read only refuses everything that does not only read; then the
 * strongest matching rule decides; with none, full access allows, and ask
 * allows reading and asks the rest. A call that would ask, with no one
 * `present` to answer, is refused instead.
 */
//@ ensures floor ==> \result === "deny"
//@ ensures !floor && mode === "read" && access !== "read" ==> \result === "deny"
//@ ensures !floor && !(mode === "read" && access !== "read") && rule === "deny" ==> \result === "deny"
//@ ensures !floor && !(mode === "read" && access !== "read") && rule === "ask" ==> \result === (present ? "ask" : "deny")
//@ ensures !floor && !(mode === "read" && access !== "read") && rule === "allow" ==> \result === "allow"
//@ ensures !floor && !(mode === "read" && access !== "read") && rule === "unmatched" && (mode === "full" || access === "read") ==> \result === "allow"
//@ ensures !floor && mode === "ask" && access !== "read" && rule === "unmatched" ==> \result === (present ? "ask" : "deny")
//@ ensures \result === "allow" ==> !floor && (mode !== "read" || access === "read")
//@ ensures !present ==> \result !== "ask"
export function decide(floor: boolean, mode: Mode, access: Access, rule: RuleVerdict, present: boolean): Decision {
  if (floor) return "deny";
  if (mode === "read" && access !== "read") return "deny";
  if (rule === "deny") return "deny";
  if (rule === "allow") return "allow";
  if (rule === "ask") return present ? "ask" : "deny";
  if (mode === "full" || access === "read") return "allow";
  return present ? "ask" : "deny";
}
