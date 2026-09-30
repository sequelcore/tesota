export type NetworkPhase = "setup" | "agent";

/**
 * Decision 048's rule for what a sandbox's proxy permits in its two phases.
 * While a repository's environment is set up, it also permits the
 * destinations setup opened, such as the hosts toolchains download from; once
 * setup ends, whether it succeeded, failed or was stopped, only what is
 * allowed on its own passes: the package registries and the operator's
 * answers. So a destination setup opened stays open to the agent only when
 * it is allowed besides.
 */
//@ ensures \result <==> (allowed || (phase === "setup" && openedForSetup))
export function permitted(allowed: boolean, openedForSetup: boolean, phase: NetworkPhase): boolean {
  if (allowed) return true;
  return phase === "setup" && openedForSetup;
}
