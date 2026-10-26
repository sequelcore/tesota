import { describe, expect, it } from "vitest";
import { commandFinding, type ModelResult, modelFinding, noEvidence, proofFinding, type Receipt, receiptDetailLines, receiptFindings, receiptStanding, receiptSummary,
  receiptTone, renderReceipt } from "../src/receipt.js";
import type { Evidence } from "../src/evidence.js";
import { modelOutcome } from "../src/verification/model-rule.js";
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

  // A check that couldn't run, or whose evidence is stale, is a gap: `failed` means a check ran and showed the change wrong.
  const stale = (evidence: Evidence): Evidence => ({ ...evidence, outcome: "not_started", invalidated: "content_changed" });
  const noDafny = { ...proof, verdict: "operator" as const,
    evidence: { ...proof.evidence, outcome: "not_started" as const, output: "Dafny could not start: dafny is not installed" } };
  const timedOut = { ...passing, verdict: "operator" as const, evidence: ran("timed_out") };
  const staleTest = { ...passing, verdict: "operator" as const, evidence: stale(passing.evidence) };
  const staleProof = { ...proof, verdict: "operator" as const, evidence: stale(proof.evidence) };
  // Its evidence's outcome is the one the real check records for this run and these faults (`modelOutcome`).
  const model = (verdict: ModelResult["verdict"], run: ModelResult["run"], faults: ModelResult["faults"] = []): ModelResult => ({
    path: "models/Add.tla", language: "tla",
    header: { covers: [{ path: "src/add.ts", names: [] }], invariants: ["Safe"], atomic: [], omits: [], faults: [] }, problems: [],
    evidence: { ...ran(modelOutcome(run, faults.map((fault) => fault.verdict))), verifier: "tlc" }, run, states: run === "passed" ? 9 : 0, faults,
    staleness: "current", stale: [], writtenWithCode: false, link: "no_replay", verdict,
    ...run === "violated" ? { counterexample: { violation: "Invariant Safe is violated.", steps: [] } } : {} });
  const provedAdd: Receipt = { ...emptyReceipt, changed: [blob("src/add.ts")], proofs: [proof] };
  const unprovedAdd: Receipt = { ...emptyReceipt, changed: [blob("src/add.ts")], unverified: ["src/add.ts"] };

  it("is never failed when a check could not run, ran past its limit, or its evidence is stale", () => {
    // Dafny missing, with nothing else that passed, and beside a test that passed.
    expect(receiptStanding({ ...unprovedAdd, proofs: [noDafny] })).toBe("unverified");
    expect(receiptStanding({ ...tested, proofs: [noDafny] })).toBe("incomplete");
    // A command past its time limit.
    expect(receiptStanding({ ...unprovedAdd, tests: [timedOut] })).toBe("unverified");
    expect(receiptStanding({ ...provedAdd, tests: [timedOut] })).toBe("incomplete");
    // Evidence the settled content no longer holds.
    expect(receiptStanding({ ...unprovedAdd, tests: [staleTest] })).toBe("unverified");
    expect(receiptStanding({ ...provedAdd, tests: [staleTest] })).toBe("incomplete");
    expect(receiptStanding({ ...unprovedAdd, proofs: [staleProof], tests: [passing] })).toBe("incomplete");
    // A model TLC could not run.
    expect(receiptStanding({ ...provedAdd, models: [model("operator", "timed_out")] })).toBe("incomplete");
    // Nor while a decision is pending, as an unresolved question is.
    for (const receipt of [{ ...tested, proofs: [noDafny] }, { ...provedAdd, tests: [timedOut] }, { ...provedAdd, tests: [staleTest] },
      { ...provedAdd, models: [model("operator", "not_started")] }]) {
      expect(receiptStanding({ ...receipt, unresolvedQuestion: "Which behavior?" })).toBe("incomplete");
    }
  });

  it("is failed when a test fails, a proof does not hold, or a model breaks a rule", () => {
    expect(receiptStanding({ ...provedAdd, tests: [failing] })).toBe("failed");
    expect(receiptStanding({ ...unprovedAdd, tests: [passing], proofs: [{ ...proof, verdict: "send_back", evidence: ran("failed") }] }))
      .toBe("failed");
    expect(receiptStanding({ ...provedAdd, proofs: [proof, { ...proof, path: "src/sub.ts", verdict: "no_progress", evidence: ran("failed") }] }))
      .toBe("failed");
    expect(receiptStanding({ ...provedAdd, models: [model("send_back", "violated")] })).toBe("failed");
  });

  const fault = (verdict: ModelResult["faults"][number]["verdict"]): ModelResult["faults"][number] =>
    ({ path: "models/Fault.cfg", description: "lock removed", verdict, output: "", durationMs: 1 });
  // A header Tesota refused before TLC started: no invariant to check, so nothing ran.
  const refused: ModelResult = { ...model("no_progress", "malformed"), problems: ["its tesota-model header names no invariant"],
    header: { covers: [{ path: "src/add.ts", names: [] }], invariants: [], atomic: [], omits: [], faults: [] } };

  it("is failed for a model only on an observed violation or a planted fault it didn't catch", () => {
    expect(receiptStanding({ ...provedAdd, models: [model("send_back", "violated")] })).toBe("failed");
    expect(receiptStanding({ ...provedAdd, models: [model("no_progress", "passed", [fault("caught"), fault("passes")])] })).toBe("failed");
    // Models that could not be checked or checked nothing: a gap whichever verdict the gate gave them.
    for (const unchecked of [refused, model("send_back", "malformed"), model("no_progress", "malformed"), model("send_back", "vacuous"),
      model("send_back", "passed"), model("send_back", "passed", [fault("broken")]), model("operator", "cancelled")]) {
      expect(receiptStanding({ ...provedAdd, models: [unchecked] }), `${unchecked.run} ${unchecked.verdict}`).toBe("incomplete");
      expect(receiptStanding({ ...unprovedAdd, models: [unchecked] }), `${unchecked.run} ${unchecked.verdict}`).toBe("unverified");
      expect(receiptStanding({ ...provedAdd, models: [unchecked], unresolvedQuestion: "Which behavior?" })).toBe("incomplete");
      expect(modelFinding(unchecked), `${unchecked.run} ${unchecked.verdict}`).toMatchObject({ standing: "gap" });
      expect(modelFinding(unchecked).failed).toBeUndefined();
    }
    // A proof Dafny verified nothing of, as a contract attached to no function, checked nothing: a gap like a model with no state.
    const vacuous = { ...proof, verdict: "send_back" as const, evidence: { ...proof.evidence, outcome: "vacuous" as const } };
    expect(receiptStanding({ ...unprovedAdd, proofs: [vacuous] })).toBe("unverified");
    expect(receiptStanding({ ...tested, proofs: [vacuous] })).toBe("incomplete");
    expect(proofFinding(vacuous)).toMatchObject({ standing: "gap", label: "Proof proved nothing" });
    expect(modelFinding(model("no_progress", "passed", [fault("passes")]))).toMatchObject({ standing: "decide", failed: true });
    expect(receiptSummary({ ...provedAdd, models: [refused] }).methods.find(({ method }) => method === "Models")?.glyph).toBe("○");
  });

  it("colours a check that could not run as a gap, and one that failed red", () => {
    for (const finding of [proofFinding(noDafny), proofFinding(staleProof), commandFinding(timedOut), commandFinding(staleTest),
      modelFinding(model("operator", "timed_out"))]) {
      expect(finding).toMatchObject({ standing: "gap" });
      expect(finding.failed).toBeUndefined();
    }
    expect(receiptTone(receiptFindings({ ...provedAdd, tests: [timedOut] }))).toBe("warning");
    expect(receiptSummary({ ...provedAdd, tests: [timedOut] }).counts).not.toContain("failed check");
    for (const finding of [proofFinding({ ...proof, verdict: "send_back", evidence: ran("failed") }), commandFinding(failing),
      modelFinding(model("send_back", "violated"))]) {
      expect(finding).toMatchObject({ standing: "decide", failed: true });
    }
    expect(receiptTone(receiptFindings({ ...provedAdd, tests: [failing] }))).toBe("error");
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

describe("what a proof covers (alpha.4)", () => {
  const scope = "                Proved in LemmaScript's model: numbers are exact integers or reals, not floating-point, so rounding, NaN and Infinity aren't covered; nor are await and other unsupported features";

  it("says under each proved path, in the details, that LemmaScript's numbers are exact, not floating-point", () => {
    const receipt: Receipt = { ...emptyReceipt, changed: [blob("src/add.ts"), blob("src/sub.ts")],
      proofs: [proof, { ...proof, path: "src/sub.ts" }] };
    for (const text of [renderReceipt(receipt), receiptDetailLines(receipt).join("\n")]) {
      const lines = text.split("\n");
      for (const path of ["src/add.ts", "src/sub.ts"]) expect(lines[lines.indexOf(`  proved        ${path}`) + 1]).toBe(scope);
    }
  });

  it("says nothing of a proof's scope under one that did not hold, did not run or is stale", () => {
    const receipt: Receipt = { ...emptyReceipt, changed: [blob("src/add.ts")], unverified: ["src/add.ts"],
      proofs: [{ ...proof, verdict: "send_back", evidence: ran("failed") }, { ...proof, path: "src/sub.ts", verdict: "operator",
        evidence: { ...proof.evidence, outcome: "not_started", invalidated: "content_changed" } }] };
    expect(renderReceipt(receipt)).not.toContain("Proved in LemmaScript's model");
  });
});
