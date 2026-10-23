/**
 * The gate's checks, which only settling a run needs: reading what a change
 * weakens, measuring contracts, running tests, checking models and covering
 * lines. The gate loads them when a run first settles rather than with
 * Tesota, so Tesota starts in less time and memory (#446).
 */
import * as Effect from "effect/Effect";

// Export only what the gate runs. A dynamic import of Effect's namespace retains every export,
// including code shared with the loop that Bun would otherwise remove from the startup chunks.
export const gateEffect: Pick<typeof Effect, "all" | "callback" | "die" | "gen" | "map" | "promise" | "runPromise" | "succeed"> = {
  all: Effect.all, callback: Effect.callback, die: Effect.die, gen: Effect.gen, map: Effect.map, promise: Effect.promise,
  runPromise: Effect.runPromise, succeed: Effect.succeed,
};

export { changeLines } from "./change-lines.js";
export { checkModel, modelFailure, modelReport, plannedModels, unheadedReport } from "./model-check.js";
export { contractStrength } from "./proof-guarantees.js";
export { uncoveredLines } from "./proof-coverage.js";
export { exerciseTests, runCommands } from "./test-rung.js";
export { commentLines, isSourcePath, isTestPath, needsContent, weakenedEvidence, withGrammarComments } from "./verification-changes.js";
