import { noLines, noRequestReview, type Receipt } from "../src/receipt.js";

/** A receipt of a run in a repository that changed nothing the gate verifies, for tests to fill in. */
export const emptyReceipt: Receipt = { version: 3, repository: true, base: null, startedAt: "2026-10-08T10:00:00.000Z",
  settledAt: "2026-10-08T10:05:00.000Z", engine: "0.1.0", codeEvidence: { proofs: [], tests: [], exercises: [], unverified: [], uncovered: [] },
  specificationEvidence: { contracts: [], weakened: [] }, requestContext: { requests: [] }, requestReview: noRequestReview, changed: [], lines: noLines, inherited: [], unmeasured: [],
  startState: { status: "known", head: null }, endState: { status: "known", head: null } };
