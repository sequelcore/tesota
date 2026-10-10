import { type Evidence, proofSummary } from "./evidence.js";
import { inFolder } from "./projects.js";
import type { UncoveredLines } from "./proof-coverage.js";
import type { ClaimCheckRun, ContractStrength } from "./proof-guarantees.js";
import type { CommandRun, TestExercise } from "./test-rung.js";
import type { Weakening } from "./verification-changes.js";
import type { GateVerdict } from "./verification/gate-rule.js";
import { decisions, type Standing } from "./verification/verdict-rule.js";

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
  /** Present when every line the request added or removed is blank or only a comment, so it changed no code. */
  readonly commentsOnly?: true;
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
  /**
   * In a folder of Git repositories that is in none (#384), what each unit
   * holds, in name order: each repository the request changed, measured from
   * its own base, with its paths and commands relative to it; and, once a
   * tool may have changed files, each folder in no repository, with nothing
   * verified. The fields above then hold nothing, and `base` is null.
   */
  readonly units?: readonly ReceiptUnit[];
}

/** What a receipt records for one repository or folder; the receipt itself is one, for the folder Pi runs in. */
export type UnitEvidence = Pick<Receipt, "repository" | "base" | "proofs" | "contracts" | "claimcheck" | "tests" | "exercises" |
  "weakened" | "unverified" | "commentsOnly" | "uncovered" | "changed">;

/** A unit's evidence and its folder, relative to the folder Pi runs in; empty for that folder's own files. */
export type ReceiptUnit = UnitEvidence & { readonly folder: string };

/** The evidence of a unit that verified nothing. */
export const noEvidence: Omit<UnitEvidence, "repository" | "base" | "claimcheck" | "commentsOnly"> = { proofs: [], contracts: [],
  tests: [], exercises: [], weakened: [], unverified: [], uncovered: [], changed: [] };

/** A unit's path as seen from the folder Pi runs in. */
export function inUnit(folder: string, path: string): string {
  return folder === "" ? path : `${folder}/${path}`;
}

/**
 * A unit's evidence as the operator and the agent read it from the folder Pi
 * runs in: its paths below its folder and its commands run from it.
 */
export function fromFolder(unit: ReceiptUnit): UnitEvidence {
  const { folder } = unit;
  if (folder === "") return unit;
  const at = (path: string): string => inUnit(folder, path);
  const checked = (evidence: Evidence): Evidence => ({ ...evidence, files: evidence.files.map(at) });
  return { ...unit,
    proofs: unit.proofs.map((proof) => ({ ...proof, path: at(proof.path), evidence: checked(proof.evidence) })),
    contracts: unit.contracts.map((contract) => ({ ...contract, path: at(contract.path) })),
    tests: unit.tests.map((run) => ({ ...run, command: inFolder(folder, run.command), evidence: checked(run.evidence) })),
    exercises: unit.exercises.map((exercise) => ({ ...exercise, path: at(exercise.path) })),
    weakened: typeof unit.weakened === "string" ? unit.weakened : unit.weakened.map((change) => ({ ...change, path: at(change.path) })),
    unverified: unit.unverified.map(at),
    uncovered: unit.uncovered.map((lines) => ({ ...lines, path: at(lines.path) })),
    changed: typeof unit.changed === "string" ? unit.changed : unit.changed.map((file) => ({ ...file, path: at(file.path) })) };
}

/** The receipt's units: each unit of a folder of repositories, or the receipt as the one unit of the folder Pi runs in. */
export function receiptUnits(receipt: Receipt): readonly ReceiptUnit[] {
  return receipt.units ?? [{ ...receipt, folder: "" }];
}

/**
 * The repositories' evidence together, as from the folder Pi runs in, for
 * counts: a weakening that could not be checked in any repository marks the
 * whole, and only changes that are all comments are comments only.
 */
export function allEvidence(receipt: Receipt): UnitEvidence {
  if (receipt.units === undefined) return receipt;
  const units = receipt.units.filter(({ repository }) => repository).map(fromFolder);
  const unread = units.find(({ weakened }) => typeof weakened === "string")?.weakened;
  const changed = units.some((unit) => typeof unit.changed === "string") ? "unreadable" as const
    : units.flatMap((unit) => typeof unit.changed === "string" ? [] : unit.changed);
  return { repository: units.length > 0, base: null,
    proofs: units.flatMap(({ proofs }) => proofs), contracts: units.flatMap(({ contracts }) => contracts),
    tests: units.flatMap(({ tests }) => tests), exercises: units.flatMap(({ exercises }) => exercises),
    weakened: typeof unread === "string" ? unread : units.flatMap(({ weakened }) => typeof weakened === "string" ? [] : weakened),
    unverified: units.flatMap(({ unverified }) => unverified), uncovered: units.flatMap(({ uncovered }) => uncovered), changed,
    ...units.length > 0 && units.every(({ commentsOnly }) => commentsOnly === true) ? { commentsOnly: true as const } : {} };
}

/**
 * The repository at `folder` of a folder of repositories as a receipt of its
 * own, for a pull request in it, with `folder` kept; nothing when the
 * request did not change it.
 */
export function unitReceipt(receipt: Receipt, folder: string): Receipt | undefined {
  const unit = receipt.units?.find((candidate) => candidate.folder === folder && candidate.repository);
  const { version, startedAt, settledAt, pi, model } = receipt;
  return unit === undefined ? undefined : { ...unit, version, startedAt, settledAt, pi, ...model === undefined ? {} : { model } };
}

/** How a folder in no repository is named: the folder Pi runs in holds only its own files there. */
function plainFolder(folder: string): string {
  return folder === "" ? "the workspace's own files" : folder;
}

/** Why a folder in no repository was not verified. */
function plainReason(folder: string): string {
  return `${folder === "" ? "they are" : "it is"} in no Git repository, so Tesota cannot tell what changed`;
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

/** Whether a session entry's details hold a receipt this Tesota reads. */
export function isReceipt(value: unknown): value is Receipt {
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 1;
}

/** Which check a finding comes from. */
export type Check = "proof" | "tests" | "weakening" | "contract" | "exercise" | "request" | "coverage";

/**
 * One fact of the receipt for people, in plain words: what it asks of the
 * operator (`decisions`), its label, what it is about, why, and what only the
 * expanded view shows.
 */
export interface Finding {
  readonly standing: Standing;
  readonly check: Check;
  /** A failure, as opposed to something weak or unproved; it only colors the finding. */
  readonly failed?: true;
  readonly label: string;
  readonly subject: string;
  readonly detail: string;
  readonly more: readonly string[];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const checked = (evidence: Evidence): string =>
  `Checked ${evidence.files.join(", ")} · sha256 ${evidence.contentHash.slice(0, 12)} · ${seconds(evidence.durationMs)}`;

/** What mutation found about one contract, as a finding. */
export function contractFinding({ path, name, mutation }: ContractStrength): Finding {
  const tried = mutation.rejected + mutation.survived.length + mutation.inconclusive + mutation.equivalent;
  const tally = [mutation.rejected > 0 ? `${mutation.rejected} caught` : "",
    mutation.equivalent > 0 ? `${mutation.equivalent} behave the same as the code` : "",
    mutation.inconclusive > 0 ? `${mutation.inconclusive} undecided` : ""].filter((part) => part !== "").join(" · ");
  const subject = `${name} · ${path}`;
  if (tried === 0) {
    return { standing: "gap", check: "contract", label: "Contract not measured", subject, detail: "no change to its code to try", more: [] };
  }
  // Strength needs a change the proof caught; changes that behave the same or stay undecided show nothing either way.
  if (mutation.survived.length === 0 && mutation.rejected === 0) {
    return { standing: "gap", check: "contract", label: "Contract not measured", subject,
      detail: "no change tried both differs from the code and was decided", more: [`Of ${tried} changes tried: ${tally}.`] };
  }
  if (mutation.survived.length === 0) {
    return { standing: "holds", check: "contract", label: "Contract strong", subject,
      detail: `all ${plural(mutation.rejected, "change", "changes")} to its code break the proof`, more: [`Of ${tried} changes tried: ${tally}.`] };
  }
  return { standing: "decide", check: "contract", label: "Contract too weak", subject,
    detail: `${plural(mutation.survived.length, "change", "changes")} to its code still ${mutation.survived.length === 1 ? "proves" : "prove"}`,
    more: [...mutation.survived.map(({ line: at, before, after }) => `line ${at}: ${before} → ${after}`), `Of ${tried} changes tried: ${tally}.`] };
}

/** A command's run as a finding: passed, still failing after it went back, or the operator's because it did not run. */
export function commandFinding({ command, verdict, evidence, failingTests }: Pick<Receipt["tests"][number],
  "command" | "verdict" | "evidence" | "failingTests">): Finding {
  const more = [`Ran in ${seconds(evidence.durationMs)} · sha256 ${evidence.contentHash.slice(0, 12)}`];
  if (verdict === "proved") return { standing: "holds", check: "tests", label: "Tests pass", subject: command, detail: "", more };
  if (verdict === "operator") {
    return { standing: "decide", check: "tests", failed: true, label: "Tests did not run", subject: command, detail: `it ${why(evidence)}`, more };
  }
  return { standing: "decide", check: "tests", failed: true, label: "Tests fail", subject: command,
    detail: failingTests === undefined || failingTests.length === 0 ? "the command fails"
      : `${plural(failingTests.length, "test fails", "tests fail")}: ${failingTests.join("; ")}`, more };
}

/** A proof as a finding. */
export function proofFinding({ path, verdict, evidence }: Pick<Receipt["proofs"][number], "path" | "verdict" | "evidence">): Finding {
  const summary = proofSummary(evidence);
  if (verdict === "proved") {
    return { standing: "holds", check: "proof", label: "Proved", subject: path, detail: summary.words, more: [checked(evidence)] };
  }
  return { standing: "decide", check: "proof", failed: true, label: verdict === "operator" ? "Proof did not run" : "Proof fails",
    subject: path, detail: summary.words, more: [...summary.at === undefined ? [] : [`at ${summary.at}`], checked(evidence)] };
}

const judgmentWords: Readonly<Record<NonNullable<ContractStrength["judgment"]>["verdict"], string>> = {
  justified: "matches the request", partially_justified: "covers only part of the request",
  not_justified: "does not match the request", vacuous: "proves nothing beyond its assumptions",
};

/** ClaimCheck's view of each contract: a model's opinion, never evidence, and never one of the receipt's decisions. */
function opinionFindings(run: ClaimCheckRun | undefined, contracts: readonly ContractStrength[]): Finding[] {
  if (run === undefined) return [];
  if (run.status === "not_judged") {
    return [{ standing: "opinion", check: "request", label: "Not compared", subject: "the contracts with the request",
      detail: `ClaimCheck ${run.reason}`, more: [] }];
  }
  const by = run.restatedBy === run.comparedBy ? `${run.comparedBy} restated and compared`
    : `${run.restatedBy} restated, ${run.comparedBy} compared`;
  return contracts.flatMap(({ path, name, judgment }): Finding[] => judgment === undefined ? [] : [{ standing: "opinion",
    check: "request", label: judgment.verdict === "justified" ? "Model: matches" : "Model: partial match",
    subject: `${name} · ${path}`, detail: judgmentWords[judgment.verdict],
    more: [judgment.explanation, `A model's opinion, not a proof: ${by}.`] }]);
}

/** Whether an opinion is a note for the operator: a model finding a contract short of the request. */
export function isNote(finding: Finding): boolean {
  return finding.standing === "opinion" && finding.label === "Model: partial match";
}

const weakeningWords: Readonly<Record<Weakening["kind"], string>> = {
  removed_contract: "removes or changes a contract line", added_requires: "adds a precondition to a function the base had",
  added_assume: "adds an assumption", deleted_test: "deletes a test file", edited_test: "edits a test",
};

/**
 * The receipt's findings for people: everything it records, each with what
 * it asks of the operator. A model's judgment is an `opinion`: shown, never
 * counted (`decisions`).
 */
export function receiptFindings(receipt: Receipt): Finding[] {
  return receipt.units === undefined ? unitFindings(receipt) : receipt.units.flatMap((unit) => unit.repository
    ? unitFindings(fromFolder(unit)) : [{ standing: "decide" as const, check: "coverage" as const, label: "Not verified",
      subject: plainFolder(unit.folder), detail: plainReason(unit.folder), more: [] }]);
}

/** One unit's findings, from the folder Pi runs in; each unit's tests decide how its unproved files are worded. */
function unitFindings(receipt: UnitEvidence): Finding[] {
  if (!receipt.repository) {
    return [{ standing: "decide", check: "coverage", label: "Not verified", subject: "this request's changes",
      detail: "the project has no Git repository, so Tesota cannot tell which files changed", more: [] }];
  }
  const tested = receipt.tests.length > 0 && receipt.tests.every(({ verdict }) => verdict === "proved");
  const unproved = tested ? "Not proved" : "Not verified";
  const unread = typeof receipt.weakened === "string";
  const found: Finding[] = [
    ...receipt.proofs.map(proofFinding),
    ...receipt.tests.map(commandFinding),
    ...typeof receipt.weakened === "string"
      ? [{ standing: "decide" as const, check: "weakening" as const, label: "Weakening not checked", subject: "the change",
        detail: receipt.weakened === "too_large" ? "it is too large to check for weakening" : "Git could not show it", more: [] }]
      : receipt.weakened.map((change): Finding => ({ standing: "decide", check: "weakening", label: "May weaken the evidence",
        subject: change.path, detail: weakeningWords[change.kind], more: "annotation" in change ? [change.annotation] : [] })),
    ...receipt.contracts.map(contractFinding),
    ...receipt.exercises.map(({ path, finding, reason }): Finding => finding === "exercises"
      ? { standing: "holds", check: "exercise", label: "Test catches the change", subject: path, detail: reason, more: [] }
      : finding === "does_not_exercise"
        ? { standing: "decide", check: "exercise", label: "Test misses the change", subject: path, detail: reason, more: [] }
        : { standing: "gap", check: "exercise", label: "Test not checked", subject: path, detail: reason, more: [] }),
    ...opinionFindings(receipt.claimcheck, receipt.contracts),
    ...unread && receipt.proofs.length > 0
      ? [{ standing: "gap" as const, check: "coverage" as const, label: "Coverage not checked", subject: "the changed lines",
        detail: "for the same reason", more: [] }] : [],
    ...receipt.uncovered.filter(({ lines }) => lines.length > 0).map(({ path, lines }): Finding => ({ standing: "gap",
      check: "coverage", label: unproved, subject: `${path} ${lines.length === 1 && lines[0]?.[0] === lines[0]?.[1] ? "line" : "lines"} ` +
        lines.map(([start, end]) => start === end ? `${start}` : `${start}–${end}`).join(", "),
      detail: tested ? "outside any contract; the tests pass with them" : "outside any contract, and nothing checked them", more: [] })),
    ...receipt.unverified.map((path): Finding => ({ standing: "gap", check: "coverage", label: unproved, subject: path,
      detail: tested ? "no contract; the tests pass with it" : "nothing checked it", more: [] })),
  ];
  // A change of comments alone leaves nothing to list; the receipt says so rather than ending empty.
  return found.length === 0 && receipt.commentsOnly === true ? [{ standing: "holds", check: "coverage",
    label: "Nothing to verify", subject: "", detail: "the changes are comments or blank lines only", more: [] }] : found;
}

/** How many of the receipt's findings need the operator; none makes it clean, in the footer and the conversation alike. */
export function receiptDecisions(receipt: Receipt): number {
  return decisions(receiptFindings(receipt).map(({ standing }) => standing));
}

/** The receipt as the operator reads it; `details` of its session entry carries the receipt itself. */
export function renderReceipt(receipt: Receipt): string {
  return ["Tesota receipt", ...receipt.units === undefined ? unitLines(receipt) : receipt.units.flatMap((unit) => unit.repository
    ? unitLines(fromFolder(unit)) : [`  not verified  ${plainFolder(unit.folder)}: ${plainReason(unit.folder)}`])].join("\n");
}

/** One unit's lines of the receipt, from the folder Pi runs in. */
function unitLines(receipt: UnitEvidence): string[] {
  if (!receipt.repository) {
    return ["  not verified  this request's changes: the project has no Git repository, so Tesota cannot tell which files changed"];
  }
  const tested = receipt.tests.length > 0 && receipt.tests.every(({ verdict }) => verdict === "proved");
  const listed = [
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
  ];
  // A change of comments alone leaves nothing to list; the receipt says so rather than ending empty.
  const nothing = listed.length === 0 && receipt.commentsOnly === true
    ? ["  no code       nothing to verify: the changes are comments or blank lines only"] : [];
  return [...listed, ...nothing];
}
