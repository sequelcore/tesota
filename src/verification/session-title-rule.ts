/**
 * Where a session's name came from: Tesota's counter ("Session 2"), the
 * operator's first request shortened, a model's title for that request, or
 * the operator's own `/rename`.
 */
export type TitleSource = "counter" | "request" | "generated" | "operator";

/**
 * Decision 036's rule for replacing a session's name. The operator's name
 * always wins and is never replaced by anything else; a model's title
 * replaces only the counter or the shortened request, which exist to show
 * something at once; and the shortened request replaces only the counter. So
 * a late or repeated title never undoes a rename.
 */
//@ ensures \result <==> (next === "operator" || (current === "counter" && next !== "counter") || (current === "request" && next === "generated"))
export function replacesTitle(current: TitleSource, next: TitleSource): boolean {
  if (next === "operator") return true;
  if (current === "counter") return next !== "counter";
  return current === "request" && next === "generated";
}
