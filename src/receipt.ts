import type { Evidence } from "./evidence.js";
import type { CommandRun, TestExercise } from "./test-rung.js";
import type { Weakening } from "./verification-changes.js";
import type { GateVerdict } from "./verification/gate-rule.js";

/**
 * What a run that changed files leaves the operator when it settles: each
 * changed file with contracts, the gate's verdict on its proof and the
 * evidence, bound to the content it checked; the project's commands, such as
 * its tests, with theirs; whether each changed or added test exercises the
 * change; the changes that may weaken the evidence; and the changed files no
 * proof covers. Changes are measured against the commit the operator's
 * request started from.
 */
export interface Receipt {
  readonly version: 0;
  /** False when the project has no Git repository, so nothing could tell which files changed or verify them. */
  readonly repository: boolean;
  readonly proofs: readonly { readonly path: string; readonly verdict: GateVerdict; readonly evidence: Evidence }[];
  readonly tests: readonly (CommandRun & { readonly verdict: GateVerdict })[];
  readonly exercises: readonly TestExercise[];
  /**
   * The changes that may weaken the evidence, or why they could not be
   * checked: the change from the base is larger than the gate reads
   * (`too_large`), or Git could not show it (`unreadable`).
   */
  readonly weakened: readonly Weakening[] | "too_large" | "unreadable";
  /** Changed files, relative to the project, that no proof covers. */
  readonly unverified: readonly string[];
}

function why(evidence: Evidence): string {
  return evidence.outcome === "timed_out" ? "ran past its time limit" : evidence.outcome === "cancelled"
    ? "was stopped" : `could not run: ${evidence.output.split("\n").at(-1) ?? ""}`;
}

function line(path: string, verdict: GateVerdict, evidence: Evidence): string {
  if (verdict === "proved") return `  proved        ${path}`;
  if (verdict === "operator") return `  NOT proved    ${path}: the proof ${why(evidence)}`;
  const what = evidence.outcome === "vacuous" ? "Dafny verified nothing" : "an obligation fails";
  return `  NOT proved    ${path}: ${what}, repeating a failure already sent back`;
}

function testLine({ command, verdict, evidence, failingTests }: Receipt["tests"][number]): string {
  if (verdict === "proved") return `  passed        ${command}`;
  if (verdict === "operator") return `  NOT passed    ${command}: it ${why(evidence)}`;
  if (failingTests === undefined || failingTests.length === 0) {
    return `  NOT passed    ${command}: it still fails after its failure went back`;
  }
  return `  NOT passed    ${command}: these tests fail, as they did when they went back: ${failingTests.join("; ")}`;
}

const exerciseText: Readonly<Record<TestExercise["finding"], string>> = {
  exercises: "exercises     ", does_not_exercise: "vacuous test  ", unknown: "exercise?     ",
};

function weakening(change: Weakening): string {
  const what = change.kind === "removed_contract" ? `removes or changes ${change.annotation}`
    : change.kind === "added_requires" ? `adds ${change.annotation} to a function the base had`
    : change.kind === "added_assume" ? `adds ${change.annotation}`
      : change.kind === "deleted_test" ? "deletes a test file" : "edits a test file";
  return `  may weaken    ${change.path}: ${what}`;
}

/** The receipt as the operator reads it; `details` of its session entry carries the receipt itself. */
export function renderReceipt(receipt: Receipt): string {
  if (!receipt.repository) {
    return "Tesota receipt\n  not verified  this request's changes: the project has no Git repository, so Tesota " +
      "cannot tell which files changed";
  }
  const tested = receipt.tests.length > 0 && receipt.tests.every(({ verdict }) => verdict === "proved");
  return [
    "Tesota receipt",
    ...receipt.proofs.flatMap(({ path, verdict, evidence }) =>
      [line(path, verdict, evidence), `                content sha256 ${evidence.contentHash}`]),
    ...receipt.tests.map(testLine),
    ...receipt.exercises.map(({ path, finding, reason }) => `  ${exerciseText[finding]}${path}: ${reason}`),
    ...receipt.weakened === "too_large"
      ? ["  not checked   weakened evidence: the change is too large to check for weakening"]
      : receipt.weakened === "unreadable"
        ? ["  not checked   weakened evidence: Git could not show the change"] : receipt.weakened.map(weakening),
    ...receipt.unverified.map((path) => tested
      ? `  not proved    ${path}: no proof covers it; the project's commands pass with it`
      : `  not verified  ${path}: no verifier covers it`),
  ].join("\n");
}
