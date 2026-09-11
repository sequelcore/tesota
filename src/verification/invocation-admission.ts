export type InvocationPhase = "inference" | "verification";
export type InvocationAdmission = "allow" | "deny";

//@ ensures used < 0 || limit <= 0 ==> \result === "deny"
//@ ensures used >= limit ==> \result === "deny"
//@ ensures used >= 0 && limit > 0 && used < limit ==> \result === "allow"
export function canAdmitInvocation(
  phase: InvocationPhase,
  used: number,
  limit: number,
): InvocationAdmission {
  if (phase !== "inference" && phase !== "verification") return "deny";
  if (used < 0 || limit <= 0) return "deny";
  return used < limit ? "allow" : "deny";
}
