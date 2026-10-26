/**
 * What Tesota can verify in a project before any request: proofs where it
 * has LemmaScript contracts, tests where it has commands that check it.
 */
export type Readiness = "proofs_and_tests" | "proofs_only" | "tests_only" | "nothing";

//@ ensures (\result === "proofs_and_tests" || \result === "proofs_only") <==> contracts
//@ ensures (\result === "proofs_and_tests" || \result === "tests_only") <==> tests
export function readiness(contracts: boolean, tests: boolean): Readiness {
  if (contracts) return tests ? "proofs_and_tests" : "proofs_only";
  return tests ? "tests_only" : "nothing";
}

/** How much of the evidence the footer's row shows: its words, shorter words, or glyphs. */
export type EvidenceLevel = "full" | "short" | "glyphs";

/** Whole elapsed minutes and seconds; elapsedMs is a nonnegative integer duration, never a remaining-time estimate. */
//@ requires elapsedMs >= 0
//@ ensures \result.minutes >= 0 && \result.seconds >= 0 && \result.seconds < 60
//@ ensures \result.minutes * 60000 + \result.seconds * 1000 <= elapsedMs
//@ ensures elapsedMs < \result.minutes * 60000 + \result.seconds * 1000 + 1000
export function elapsedTime(elapsedMs: number): { minutes: number; seconds: number } {
  return { minutes: Math.floor(elapsedMs / 60000), seconds: Math.floor(elapsedMs / 1000) % 60 };
}

export interface FooterLayout {
  level: EvidenceLevel;
  /** Whether the context % shows on the right. */
  context: boolean;
  /** Whether the model shows on the right. */
  model: boolean;
  /** Whether the folder shows on the right. */
  place: boolean;
}

/**
 * The columns the right side of the footer's row takes: the folder, the
 * model and the context % that show, then the statuses, which always do
 * (`status` is 0 without any), three columns between each.
 */
//@ requires place >= 0 && model >= 0 && context >= 0 && status >= 0
//@ ensures \result >= 0
export function rightWidth(place: number, model: number, context: number, status: number, showsPlace: boolean, showsModel: boolean,
  showsContext: boolean): number {
  const count = (showsPlace ? 1 : 0) + (showsModel ? 1 : 0) + (showsContext ? 1 : 0) + (status > 0 ? 1 : 0);
  const items = (showsPlace ? place : 0) + (showsModel ? model : 0) + (showsContext ? context : 0) + status;
  return count === 0 ? 0 : items + 3 * (count - 1);
}

/** Whether evidence `left` wide and a right side `right` wide fit in `width` columns, two columns between them. */
//@ requires left >= 0 && right >= 0
//@ ensures \result <==> (right === 0 ? left <= width : left + 2 + right <= width)
export function fits(width: number, left: number, right: number): boolean {
  return right === 0 ? left <= width : left + 2 + right <= width;
}

/**
 * What the footer's one row shows in `width` columns, given the widths of
 * the evidence at each level (`full` ≥ `short` ≥ `glyphs`) on the left, and
 * on the right of the folder, the model, the context % and the statuses,
 * the permission mode among them. The first that fits of: everything; no
 * folder; no model; shorter evidence; glyphs; no context %. The statuses
 * always show, so the row never hides the permission mode.
 */
//@ requires full >= short && short >= glyphs && glyphs >= 0 && context >= 0 && place >= 0 && model >= 0 && status >= 0
//@ ensures \result.place <==> fits(width, full, rightWidth(place, model, context, status, true, true, true))
//@ ensures \result.model <==> (\result.place || fits(width, full, rightWidth(place, model, context, status, false, true, true)))
//@ ensures \result.level === "full" <==> (\result.model || fits(width, full, rightWidth(place, model, context, status, false, false, true)))
//@ ensures \result.level === "short" <==> (\result.level !== "full" && fits(width, short, rightWidth(place, model, context, status, false, false, true)))
//@ ensures \result.context <==> (\result.level !== "glyphs" || fits(width, glyphs, rightWidth(place, model, context, status, false, false, true)))
//@ ensures \result.place ==> \result.model
//@ ensures \result.model ==> \result.context
export function footerLayout(width: number, full: number, short: number, glyphs: number, context: number, place: number,
  model: number, status: number): FooterLayout {
  if (fits(width, full, rightWidth(place, model, context, status, true, true, true))) {
    return { level: "full", context: true, model: true, place: true };
  }
  if (fits(width, full, rightWidth(place, model, context, status, false, true, true))) {
    return { level: "full", context: true, model: true, place: false };
  }
  const contextOnly = rightWidth(place, model, context, status, false, false, true);
  if (fits(width, full, contextOnly)) return { level: "full", context: true, model: false, place: false };
  if (fits(width, short, contextOnly)) return { level: "short", context: true, model: false, place: false };
  return { level: "glyphs", context: fits(width, glyphs, contextOnly), model: false, place: false };
}
