/** How freely the agent may act (#449): only read, ask before anything else, or act without asking. */
export type Mode = "read" | "ask" | "full";

/** What a tool call does: only reads, writes or edits files, or runs something. */
export type Access = "read" | "write" | "run";

/** The strongest of the rules that match a call, `unmatched` when none does. */
export type RuleVerdict = "allow" | "ask" | "deny" | "unmatched";

export type Decision = "allow" | "ask" | "deny";

/**
 * The closed set of normalized command names whose literal quoted arguments
 * may be treated as data (#681). Callers must still reject execution options,
 * interpolation, ambiguous syntax and unrecognized pipeline consumers.
 */
//@ ensures \result === (command === "rg" || command === "grep" || command === "select-string" || command === "echo")
export function isDataCommand(command: string): boolean {
  return command === "rg" || command === "grep" || command === "select-string" || command === "echo";
}

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

/**
 * Whether `path` is `folder` or inside it, each a canonical path as its
 * names from the root: the folder's names begin the path's, whole, so
 * `project-other` is not inside `project`.
 */
//@ ensures \result === (folder.length <= path.length && forall(j: nat, j < folder.length ==> path[j] === folder[j]))
export function within(path: readonly string[], folder: readonly string[]): boolean {
  if (folder.length > path.length) return false;
  let k = 0;
  while (k < folder.length) {
    //@ invariant 0 <= k && k <= folder.length
    //@ invariant forall(j: nat, j < k ==> path[j] === folder[j])
    if (path[k] !== folder[k]) return false;
    k = k + 1;
  }
  return true;
}

/**
 * Whether the floor lets a file tool write at `path` (#449, #653): only in
 * the session's folder or its scratch folder, each a canonical path as its
 * names from the root.
 */
//@ ensures \result === ((folder.length <= path.length && forall(j: nat, j < folder.length ==> path[j] === folder[j])) || (scratch.length <= path.length && forall(j: nat, j < scratch.length ==> path[j] === scratch[j])))
export function writable(path: readonly string[], folder: readonly string[], scratch: readonly string[]): boolean {
  return within(path, folder) || within(path, scratch);
}

/**
 * A decision once Tesota's floor has refused a call earlier in the same
 * request (#622): a call that would be allowed and does more than read is
 * asked instead, or refused with no one `present`, since the floor is a net
 * over what calls name and another route can reach what it refused.
 * Nothing it refused or asked loosens.
 */
//@ ensures !refused ==> \result === decision
//@ ensures refused && decision === "allow" && access !== "read" ==> \result === (present ? "ask" : "deny")
//@ ensures refused && !(decision === "allow" && access !== "read") ==> \result === decision
//@ ensures !present && decision !== "ask" ==> \result !== "ask"
export function afterRefusal(decision: Decision, access: Access, refused: boolean, present: boolean): Decision {
  if (!refused || decision !== "allow" || access === "read") return decision;
  return present ? "ask" : "deny";
}
