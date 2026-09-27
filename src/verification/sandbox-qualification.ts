export type FilesystemClaim = "host" | "workspace";
export type NetworkClaim = "open" | "allowlist";

/**
 * Decision 030's qualification rule. A provider keeps its claim to confine
 * files to the workspace only when it makes the claim and, on this machine,
 * the controls every environment must pass and the file controls all passed;
 * otherwise it is treated as reaching the host. A failed or missing control
 * can only withdraw a claim, never grant one.
 */
//@ ensures \result === "workspace" <==> (claimed === "workspace" && processPassed && filesystemPassed)
export function qualifiedFilesystem(claimed: FilesystemClaim, processPassed: boolean, filesystemPassed: boolean): FilesystemClaim {
  if (claimed !== "workspace") return "host";
  return processPassed && filesystemPassed ? "workspace" : "host";
}

/** The same rule for a network allowlist: kept only when claimed and its controls passed on this machine. */
//@ ensures \result === "allowlist" <==> (claimed === "allowlist" && processPassed && networkPassed)
export function qualifiedNetwork(claimed: NetworkClaim, processPassed: boolean, networkPassed: boolean): NetworkClaim {
  if (claimed !== "allowlist") return "open";
  return processPassed && networkPassed ? "allowlist" : "open";
}

/**
 * Decision 030's choice rule: commands run without asking only in a provider
 * that is ready on this machine and whose qualified guarantees confine both
 * files and network; anywhere else each command asks first.
 */
//@ ensures \result <==> (ready && filesystem === "workspace" && network === "allowlist")
export function runsWithoutAsking(ready: boolean, filesystem: FilesystemClaim, network: NetworkClaim): boolean {
  return ready && filesystem === "workspace" && network === "allowlist";
}
