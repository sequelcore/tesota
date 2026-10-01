/**
 * The operator's permission mode, switched with Shift+Tab as in Claude Code
 * and Codex. Read only: the agent edits nothing and every command asks.
 * Accept edits: edits land without asking, commands in a qualified sandbox
 * run without asking, and a command on this computer asks unless a rule the
 * operator saved allows it. Full access: every command runs on this computer
 * without asking. Every mode records each turn, so `/revert` undoes it.
 */

export type PermissionMode = "read-only" | "accept-edits" | "full-access";

/** Where a command runs: the session's qualified sandbox, or this computer. */
export type CommandPlace = "sandbox" | "computer";

/** Whether the agent's file tools may change files. */
//@ ensures \result <==> mode !== "read-only"
export function editsAllowed(mode: PermissionMode): boolean {
  return mode !== "read-only";
}

/** Where the agent's commands run: this computer in full access or without a sandbox, the sandbox otherwise. */
//@ ensures (\result === "computer") <==> (mode === "full-access" || !sandboxed)
export function commandPlace(mode: PermissionMode, sandboxed: boolean): CommandPlace {
  return mode === "full-access" || !sandboxed ? "computer" : "sandbox";
}

/**
 * Whether a command runs without asking the operator. Read only always asks,
 * whatever rules were saved; full access never asks; accept edits asks only
 * on this computer without a saved rule.
 */
//@ ensures \result <==> (mode === "full-access" || mode === "accept-edits" && (place === "sandbox" || allowedByRule))
export function commandRunsWithoutAsking(mode: PermissionMode, place: CommandPlace, allowedByRule: boolean): boolean {
  if (mode === "full-access") return true;
  if (mode === "read-only") return false;
  return place === "sandbox" || allowedByRule;
}

/** Whether the question for a command offers to save a rule: only where saved rules apply, in accept edits. */
//@ ensures \result <==> mode === "accept-edits"
export function offersRule(mode: PermissionMode): boolean {
  return mode === "accept-edits";
}

/** Shift+Tab's next mode: read only, accept edits, full access, then read only again. */
//@ ensures mode === "read-only" ==> \result === "accept-edits"
//@ ensures mode === "accept-edits" ==> \result === "full-access"
//@ ensures mode === "full-access" ==> \result === "read-only"
export function nextMode(mode: PermissionMode): PermissionMode {
  if (mode === "read-only") return "accept-edits";
  return mode === "accept-edits" ? "full-access" : "read-only";
}

/** Whether entering `next` asks the operator first: full access does, once per session. */
//@ ensures \result <==> (next === "full-access" && !confirmed)
export function needsConfirmation(next: PermissionMode, confirmed: boolean): boolean {
  return next === "full-access" && !confirmed;
}
