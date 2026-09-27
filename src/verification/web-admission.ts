export type WebPermission = "allowed" | "denied" | "unasked";
export type WebAdmission = "fetch" | "ask" | "deny" | "refuse_url" | "refuse_address";

/**
 * Decision 024's rule for reading a web page from the operator's computer: a
 * page is fetched only from a well-formed https URL without credentials, from
 * a host the operator allowed, at an address on the public internet. The
 * operator is asked before the host's address is looked up, since the lookup
 * itself reveals the name; so a URL that could never be fetched is refused
 * before any question, and the address is judged only once the host is
 * allowed.
 */
//@ ensures !validUrl ==> \result === "refuse_url"
//@ ensures validUrl && permission === "denied" ==> \result === "deny"
//@ ensures validUrl && permission === "unasked" ==> \result === "ask"
//@ ensures validUrl && permission === "allowed" && !publicAddress ==> \result === "refuse_address"
//@ ensures \result === "fetch" <==> (validUrl && permission === "allowed" && publicAddress)
export function webAdmission(validUrl: boolean, permission: WebPermission, publicAddress: boolean): WebAdmission {
  if (!validUrl) return "refuse_url";
  if (permission === "denied") return "deny";
  if (permission === "unasked") return "ask";
  if (!publicAddress) return "refuse_address";
  return "fetch";
}
