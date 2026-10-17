/**
 * The gate's checks, which only settling a run needs: reading what a change
 * weakens, measuring contracts, running tests and covering lines. The gate
 * loads them when a run first settles rather than with Tesota, so Tesota
 * starts in less time and memory (#446).
 */
export { contractStrength } from "./proof-guarantees.js";
export { uncoveredLines } from "./proof-coverage.js";
export { exerciseTests, runCommands } from "./test-rung.js";
export { commentLines, isTestPath, needsContent, weakenedEvidence, withGrammarComments } from "./verification-changes.js";
