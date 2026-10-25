import { describe, expect, it } from "vitest";
import { noEvidence, type Receipt, receiptStanding, receiptSummary, renderReceipt } from "../src/receipt.js";
import type { Evidence } from "../src/evidence.js";
import { emptyReceipt } from "./receipts.js";

// What "verified" means on every surface (#668): evidence that passed, every changed path covered, no gap, nothing to decide.

const ran = (outcome: Evidence["outcome"]): Evidence => ({ verifier: "command", claim: "the tests pass", limits: "", outcome,
  output: "", durationMs: 1, files: [], contentHash: "" });
const passing = { command: "npm test", verdict: "proved" as const, evidence: ran("passed") };
const failing = { command: "npm test", verdict: "send_back" as const, evidence: ran("failed") };
const proof = { path: "src/add.ts", verdict: "proved" as const,
  evidence: { ...ran("passed"), verifier: "lemmascript" as const, claim: "src/add.ts satisfies its contracts" } as Evidence };
const noticing = { path: "tests/add.test.ts", provenance: "added" as const, sensitivity: "fails_then_passes" as const,
  reason: "it fails on the base and passes with the change" };
const blob = (path: string): { path: string; blob: string } => ({ path, blob: "0".repeat(40) });

/** A run that changed `src/add.ts` and added its test, which ran, passed and failed on the base. */
const tested: Receipt = { ...emptyReceipt, changed: [blob("src/add.ts"), blob("tests/add.test.ts")], tests: [passing],
  exercises: [noticing], unverified: ["src/add.ts"] };

describe("the receipt's standing (#668)", () => {
  it("is verified with evidence that passed, no gap and nothing to decide", () => {
    expect(receiptStanding({ ...emptyReceipt, changed: [blob("src/add.ts")], proofs: [proof] })).toBe("verified");
    // Tested and exercised: its unit's only unproved file, every command passed, every test noticed the change.
    expect(receiptStanding(tested)).toBe("verified");
  });

  it("is incomplete with evidence when some part could not be verified", () => {
    // One passing test and an unverified path that no exercise shows the tests reached.
    expect(receiptStanding({ ...tested, exercises: [] })).toBe("incomplete");
    expect(receiptStanding({ ...tested, exercises: [{ ...noticing, sensitivity: "unknown" }] })).toBe("incomplete");
    // Two unproved files: nothing says which one the test exercised.
    expect(receiptStanding({ ...tested, changed: [...tested.changed as never[], blob("src/sub.ts")],
      unverified: ["src/add.ts", "src/sub.ts"] })).toBe("incomplete");
    // A proof that passed beside lines no contract covers.
    expect(receiptStanding({ ...emptyReceipt, changed: [blob("src/add.ts")], proofs: [proof],
      uncovered: [{ path: "src/add.ts", lines: [[3, 4]] }] })).toBe("incomplete");
    // A proof that passed beside a file nothing checked.
    expect(receiptStanding({ ...emptyReceipt, changed: [blob("src/add.ts"), blob("notes.txt")], proofs: [proof],
      unverified: ["notes.txt"] })).toBe("incomplete");
    // An inventory Git couldn't read: nothing shows every changed path was covered.
    expect(receiptStanding({ ...emptyReceipt, changed: "unreadable", proofs: [proof] })).toBe("incomplete");
  });

  it("is unverified when something changed and nothing could be verified", () => {
    // #651: an empty file created, with nothing to check it.
    expect(receiptStanding({ ...emptyReceipt, changed: [{ path: "notes.txt", blob: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391" }],
      unverified: ["notes.txt"] })).toBe("unverified");
    expect(receiptStanding({ ...emptyReceipt, changed: [blob("src/add.ts")], commentsOnly: true })).toBe("unverified");
    expect(receiptStanding({ ...emptyReceipt, changed: "unreadable" })).not.toBe("verified");
  });

  it("claims nothing when nothing changed", () => {
    expect(receiptStanding(emptyReceipt)).toBe("unchanged");
    expect(receiptStanding({ ...emptyReceipt, tests: [passing] })).toBe("unchanged");
  });

  it("is failed when a check failed, and incomplete when something needs a decision or the run stopped", () => {
    expect(receiptStanding({ ...tested, tests: [failing] })).toBe("failed");
    expect(receiptStanding({ ...tested, exercises: [{ ...noticing, sensitivity: "passes_on_base" }] })).toBe("incomplete");
    expect(receiptStanding({ ...tested, stopped: "the operator stopped the run" })).toBe("incomplete");
    expect(receiptStanding({ ...tested, unresolvedQuestion: "Which behavior?" })).toBe("incomplete");
  });

  it("leaves a covered file out of the summary's limits, and still says no proof covers it", () => {
    const summary = receiptSummary(tested);
    expect(summary.counts).not.toMatch(/verification limit(?!s)|[1-9]\d* verification limits/u);
    expect(summary.counts).toContain("no verification limits");
    expect(summary.tone).toBe("success");
    expect(summary.limits).toEqual([]);
    expect(summary.notes).toContainEqual(expect.objectContaining({ glyph: "·", title: "src/add.ts: tested and exercised; no proof covers it" }));
    const text = renderReceipt(tested);
    expect(text.split("\n")[1]).not.toMatch(/[1-9]\d* verification limit/u);
    expect(text).toContain("src/add.ts: tested and exercised; no proof covers it");
  });

  it("still counts an uncovered file as a verification limit", () => {
    const summary = receiptSummary({ ...tested, exercises: [] });
    expect(summary.counts).toContain("1 verification limit");
    expect(summary.tone).toBe("warning");
    expect(summary.limits).toContainEqual(expect.objectContaining({ items: ["src/add.ts"] }));
  });

  it("reads each unit of a folder of repositories on its own", () => {
    const known = { status: "known", head: null } as const;
    const unit = { ...noEvidence, repository: true, base: null, startState: known, endState: known };
    const { changed, tests, exercises, unverified } = tested;
    const units = { ...emptyReceipt, repository: false, units: [{ ...unit, folder: "app", changed, tests, exercises, unverified }] };
    expect(receiptStanding(units)).toBe("verified");
    // The other unit's file is unproved and has no test of its own: app's test says nothing of it.
    expect(receiptStanding({ ...units, units: [...units.units, { ...unit, folder: "web", changed: [blob("page.ts")],
      unverified: ["page.ts"] }] })).toBe("incomplete");
  });
});
