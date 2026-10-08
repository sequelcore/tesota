import type { Receipt } from "../src/receipt.js";

/** A receipt of a run in a repository that changed nothing the gate verifies, for tests to fill in. */
export const emptyReceipt: Receipt = { version: 1, repository: true, base: null, startedAt: "2026-10-08T10:00:00.000Z",
  settledAt: "2026-10-08T10:05:00.000Z", pi: "1.1.0", proofs: [], contracts: [], tests: [], exercises: [], weakened: [],
  unverified: [], uncovered: [] };
