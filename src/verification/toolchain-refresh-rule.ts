/**
 * What happens when the repository's toolchain declaration (mise.toml,
 * .tool-versions, .tesota/setup.sh) changed during a session, as when the
 * agent declares a tool a check needs: nothing installs without the
 * operator's approval, and an environment that can set up only when prepared
 * says so instead of asking.
 */

export type ToolchainStep = "unchanged" | "unavailable" | "ask";

/** Whether the operator is asked: only for a changed declaration the environment can set up now. */
//@ ensures \result === "unchanged" <==> !changed
//@ ensures \result === "unavailable" <==> (changed && !refreshable)
//@ ensures \result === "ask" <==> (changed && refreshable)
export function toolchainStep(changed: boolean, refreshable: boolean): ToolchainStep {
  if (!changed) return "unchanged";
  return refreshable ? "ask" : "unavailable";
}

/** Whether the declared tools are installed: only a changed declaration, an environment that can, and the operator's yes. */
//@ ensures \result <==> (changed && refreshable && approved)
export function installsDeclaredTools(changed: boolean, refreshable: boolean, approved: boolean): boolean {
  return toolchainStep(changed, refreshable) === "ask" && approved;
}
