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

/** How much of the evidence the footer's first row shows: its words, shorter words, or glyphs. */
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
  /** Whether the context % shows at the right of the first row. */
  context: boolean;
  /** Whether the model shows at the right of the second row. */
  model: boolean;
}

/**
 * What the footer's two rows show in `width` columns, given the widths of
 * the evidence at each level (`full` ≥ `short` ≥ `glyphs`), of the context %,
 * of the path on the second row and of the model, with two columns between
 * a row's left and right sides. As the terminal narrows the model goes
 * first, then the evidence shortens, and the context % goes last.
 */
//@ requires full >= short && short >= glyphs && glyphs >= 0 && context >= 0 && place >= 0 && model >= 0
//@ ensures \result.context <==> glyphs + 2 + context <= width
//@ ensures \result.context ==> (\result.level === "full" <==> full + 2 + context <= width)
//@ ensures \result.context ==> (\result.level === "short" <==> full + 2 + context > width && short + 2 + context <= width)
//@ ensures !\result.context ==> (\result.level === "full" <==> full <= width)
//@ ensures !\result.context ==> (\result.level === "short" <==> full > width && short <= width)
//@ ensures \result.model <==> \result.context && \result.level === "full" && place + 2 + model <= width
//@ ensures \result.model ==> \result.context
export function footerLayout(width: number, full: number, short: number, glyphs: number, context: number, place: number,
  model: number): FooterLayout {
  const showsContext = glyphs + 2 + context <= width;
  const room = showsContext ? width - 2 - context : width;
  const level: EvidenceLevel = full <= room ? "full" : short <= room ? "short" : "glyphs";
  return { level, context: showsContext, model: showsContext && level === "full" && place + 2 + model <= width };
}
