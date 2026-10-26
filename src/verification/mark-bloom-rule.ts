export type MarkStanding = "verified" | "incomplete" | "unverified" | "unchanged" | "failed" | "none";

/** The mark follows receiptStanding, not an independent interpretation of evidence. */
//@ ensures \result === (standing === "verified")
export function markBlooms(standing: MarkStanding): boolean {
  return standing === "verified";
}
