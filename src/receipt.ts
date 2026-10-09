import type { Evidence } from "./evidence.js";
import type { UncoveredLines } from "./proof-coverage.js";
import type { ClaimCheckRun, ContractStrength } from "./proof-guarantees.js";
import type { CommandRun, TestExercise } from "./test-rung.js";
import type { Weakening } from "./verification-changes.js";
import type { GateVerdict } from "./verification/gate-rule.js";

/**
 * What a run that changed files leaves the operator when it settles: each
 * changed file with contracts, the gate's verdict on its proof and the
 * evidence, bound to the content it checked; how strong each contract the
 * request added or changed is, once it proved; the project's commands, such as
 * its tests, with theirs; whether each changed or added test exercises the
 * change; the changes that may weaken the evidence; and the changed files and
 * lines no proof covers. Changes are measured against the commit the
 * operator's request started from.
 */
export interface Receipt {
  readonly version: 1;
  /** False when the project has no Git repository, so nothing could tell which files changed or verify them. */
  readonly repository: boolean;
  /** The commit `HEAD` named when the operator's request started; null before the first commit and outside Git. */
  readonly base: string | null;
  /** When the operator's request started and when its run settled, in ISO 8601. */
  readonly startedAt: string;
  readonly settledAt: string;
  /** The Pi version the run used, and the session's model as `provider/id` when it settled, if one was set. */
  readonly pi: string;
  readonly model?: string;
  readonly proofs: readonly { readonly path: string; readonly verdict: GateVerdict; readonly evidence: Evidence }[];
  /** Each contract the request added or changed in a file that proved, with what mutation and ClaimCheck found. */
  readonly contracts: readonly ContractStrength[];
  /** Which model ClaimCheck asked, or why it judged nothing; absent when no contract was there to judge. */
  readonly claimcheck?: ClaimCheckRun;
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
  /**
   * The changed lines of each TypeScript file that proved that no contract's
   * proof covers (`uncoveredLines`); none when `weakened` says the change
   * could not be read.
   */
  readonly uncovered: readonly UncoveredLines[];
  /**
   * Every file changed from `base` as the run left it, relative to the
   * project: the blob id Git would store for its content, or null when
   * deleted; `unreadable` when Git could not tell.
   */
  readonly changed: readonly { readonly path: string; readonly blob: string | null }[] | "unreadable";
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

/**
 * What mutation found about one contract. A survivor proved after the change,
 * so the contract does not rule that behavior out and is too weak to trust;
 * one whose equivalence did not prove may still behave the same as the
 * original, so it is never called a defect. Survivors proved to behave the
 * same are only counted.
 */
function mutationLines({ path, name, mutation }: ContractStrength): string[] {
  const tried = mutation.rejected + mutation.survived.length + mutation.inconclusive + mutation.equivalent;
  const unsettled = `${mutation.equivalent === 0 ? "" : `; ${mutation.equivalent} proved to behave the same as the code`}` +
    `${mutation.inconclusive === 0 ? "" : `; ${mutation.inconclusive} could not be decided`}`;
  if (tried === 0) return [`  contract      ${name} in ${path}: mutation found no change to try in its body`];
  if (mutation.survived.length === 0) {
    return [`  contract      ${name} in ${path}: all ${mutation.rejected} decided changes to its code fail the proof${unsettled}`];
  }
  return [`  weak contract ${name} in ${path}: ${mutation.survived.length} of ${tried} changes to its code still prove, so ` +
    `the contract does not rule them out (one may behave the same as the original)${unsettled}`,
  ...mutation.survived.map((mutant) => `                line ${mutant.line}: ${mutant.before} became ${mutant.after}`)];
}

const verdictText: Readonly<Record<NonNullable<ContractStrength["judgment"]>["verdict"], string>> = {
  justified: "expresses what was asked", partially_justified: "covers only part of what was asked",
  not_justified: "does not express what was asked", vacuous: "proves nothing beyond its assumptions",
};

/** ClaimCheck's view of the contracts, always labelled a model's judgment. */
function claimcheckLines(run: ClaimCheckRun | undefined, contracts: readonly ContractStrength[]): string[] {
  if (run === undefined) return [];
  if (run.status === "not_judged") {
    return [`  not judged    whether the contracts express the request: ClaimCheck ${run.reason}`];
  }
  const models = run.restatedBy === run.comparedBy
    ? `${run.comparedBy}, one model for both requests,` : `${run.restatedBy} restating and ${run.comparedBy} comparing,`;
  return [`  model judged  by ClaimCheck on ${models} a model's judgment against the request, not a proof:`,
    ...contracts.flatMap(({ path, name, judgment }) => judgment === undefined ? [] : [`                ${name} in ${path} ` +
      `${verdictText[judgment.verdict]}${judgment.verdict === "justified" ? "" : `: ${judgment.explanation}`}`])];
}

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
    ...receipt.contracts.flatMap(mutationLines),
    ...claimcheckLines(receipt.claimcheck, receipt.contracts),
    ...receipt.tests.map(testLine),
    ...receipt.exercises.map(({ path, finding, reason }) => `  ${exerciseText[finding]}${path}: ${reason}`),
    ...receipt.weakened === "too_large"
      ? ["  not checked   weakened evidence: the change is too large to check for weakening"]
      : receipt.weakened === "unreadable"
        ? ["  not checked   weakened evidence: Git could not show the change"] : receipt.weakened.map(weakening),
    ...typeof receipt.weakened === "string" && receipt.proofs.length > 0
      ? ["  not checked   which changed lines the proofs cover, for the same reason"] : [],
    ...receipt.uncovered.filter(({ lines }) => lines.length > 0).map(({ path, lines }) => {
      const one = lines.length === 1 && lines[0]?.[0] === lines[0]?.[1];
      const where = `${path} ${one ? "line" : "lines"} ${lines.map(([start, end]) => start === end ? `${start}` : `${start}-${end}`).join(", ")}`;
      return tested ? `  not proved    ${where}: outside the contracts that proved; the project's commands pass with them`
        : `  not verified  ${where}: outside the contracts that proved, and no verifier covers them`;
    }),
    ...receipt.unverified.map((path) => tested
      ? `  not proved    ${path}: no proof covers it; the project's commands pass with it`
      : `  not verified  ${path}: no verifier covers it`),
  ].join("\n");
}
