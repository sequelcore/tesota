export type MountFilesystem = "drvfs" | "plan9" | "other";
export type DistributionStep = "setup" | "restart" | "ready";

/**
 * Decision 043's rules for the WSL sandbox's distribution. A mount is one of
 * Windows' drives, whose owner decides whether Git trusts a workspace on it,
 * only when its source is a drive's root and it is a `drvfs` mount or a 9p
 * share of `drvfs`, as WSL itself tells drives from its other shares, such as
 * its GPU drivers.
 */
//@ ensures \result <==> (driveRoot && (filesystem === "drvfs" || (filesystem === "plan9" && drvfsShare)))
export function countsAsDrive(filesystem: MountFilesystem, drvfsShare: boolean, driveRoot: boolean): boolean {
  if (!driveRoot) return false;
  if (filesystem === "drvfs") return true;
  return filesystem === "plan9" && drvfsShare;
}

/** WSL's configuration asks for what the sandbox needs only with interop off and drives owned by this user and group. */
//@ ensures \result <==> (interopOff && uidMatches && gidMatches)
export function settingsAsked(interopOff: boolean, uidMatches: boolean, gidMatches: boolean): boolean {
  return interopOff && uidMatches && gidMatches;
}

/**
 * The next step for Tesota's distribution: setup while anything setup
 * installs or writes is missing, the configuration included; a restart only
 * for settings the configuration already asks for and WSL has not applied,
 * since a restart applies nothing else; ready otherwise.
 */
//@ ensures \result === "setup" <==> setupMissing
//@ ensures \result === "restart" <==> (!setupMissing && settingsPending)
export function distributionStep(setupMissing: boolean, settingsPending: boolean): DistributionStep {
  if (setupMissing) return "setup";
  return settingsPending ? "restart" : "ready";
}
