import { type Evidence, proofSummary, staleEvidenceWords } from "./evidence.js";
import { clarificationText, type Clarification } from "./clarification.js";
import type { OpenCases } from "./open-cases.js";
import { inFolder } from "./projects.js";
import type { UncoveredLines } from "./proof-coverage.js";
import type { ClaimCheckRun, ContractStrength } from "./proof-guarantees.js";
import type { Counterexample, ModelCheck, ModelLink } from "./model-check.js";
import type { GraphCapture } from "./model-graph.js";
import type { ChangeLines, LineCount } from "./change-lines.js";
import type { TestEdit, WeakenedTest } from "./test-edits.js";
import type { CommandRun, TestExercise } from "./test-rung.js";
import type { Weakening } from "./verification-changes.js";
import { attributionResolved, type StartState, type UnmeasuredPath } from "./request-fingerprint.js";
import type { GateVerdict } from "./verification/gate-rule.js";
import { clock } from "./operations.js";
import { checkEnd, decisions, methodStanding, partlyHolds, pathCovered, runStanding, type Standing, verdictTone } from "./verification/verdict-rule.js";

/** The operator requests actually supplied to one model judgment; omissions are explicit, never silent. */
export interface RequestJudgment {
  readonly method: "open_cases" | "claimcheck";
  /** The ClaimCheck unit, or the empty string for root/global context. */
  readonly folder: string;
  readonly requests: readonly { readonly run: number; readonly text: readonly string[] }[];
  readonly omitted: readonly number[];
}

/**
 * What a run that changed files leaves the operator when it settles: each
 * changed file with contracts, the gate's verdict on its proof and the
 * evidence, bound to the content it checked; how strong each contract the
 * request added or changed is, once it proved; the project's commands, such as
 * its tests, with theirs; each changed or added test's provenance and whether
 * it notices the change; the changes that may weaken the evidence; the
 * changed files and lines no proof covers; and the change in lines by
 * category. Attribution describes what changed during the request (by
 * anyone); weakening and exercise still use its admission commit.
 */
export interface Receipt {
  readonly version: 2;
  /** False when the project has no Git repository, so nothing could tell which files changed or verify them. */
  readonly repository: boolean;
  /**
   * Present when the project is in no Git repository and Tesota measured the
   * request against its own snapshot of it (#384): `base` is that snapshot,
   * which no one else can fetch.
   */
  readonly snapshot?: true;
  /** The files Tesota's snapshot left out for their size, so nothing verified them. */
  readonly tooLarge?: readonly string[];
  /**
   * Why nothing was verified, when the project has neither a repository nor a
   * snapshot; on a stopped run, why `changed` is `unreadable`.
   */
  readonly reason?: string;
  /**
   * Why the run ended before Tesota verified anything, and which checks a stop
   * interrupted or never started; present only then. Its `changed` is then an
   * inventory of what the run left, read and never checked (#599).
   */
  readonly stopped?: string;
  /** Generation ended with this unresolved question; verification still settled the changes. */
  readonly unresolvedQuestion?: string;
  /** The commit `HEAD` named when the operator's request started; null before the first commit and outside Git. */
  readonly base: string | null;
  /** When the operator's request started and when its run settled, in ISO 8601. */
  readonly startedAt: string;
  readonly settledAt: string;
  /** The version of Tesota the run used, and the session's model as `provider/id` when it settled, if one was set. */
  readonly engine: string;
  readonly model?: string;
  readonly proofs: readonly { readonly path: string; readonly verdict: GateVerdict; readonly evidence: Evidence }[];
  /** Each contract the request added or changed in a file that proved, with what mutation and ClaimCheck found. */
  readonly contracts: readonly ContractStrength[];
  /** Which model ClaimCheck asked, or why it judged nothing; absent when no contract was there to judge. */
  readonly claimcheck?: ClaimCheckRun;
  readonly tests: readonly (CommandRun & { readonly verdict: GateVerdict })[];
  readonly exercises: readonly TestExercise[];
  /**
   * Each model whose code or own files the request changed (#551), checked
   * with TLC or kept from a passing check of the same content: model-checked
   * evidence, about the model and never a proof of the code. Absent when the
   * request touched no model.
   */
  readonly models?: readonly ModelResult[];
  /** TLA+ and Quint files the request changed that declare no model header, so nothing checked them. */
  readonly unheaded?: readonly string[];
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
   * Every file changed during the request (by anyone) as the run left it, relative to the
   * project: the blob id Git would store for its content, or null when
   * deleted; `unreadable` when Git could not tell.
   */
  readonly changed: readonly { readonly path: string; readonly blob: string | null }[] | "unreadable";
  /** The files in `changed` in lines by category (`changeLines`, #527); `unreadable` when Git could not show the change. */
  readonly lines: ChangeLines | "unreadable";
  /** Paths dirty at the first non-reader tool whose content stayed unchanged; tests ran with them. */
  readonly inherited: readonly string[];
  /** Paths whose content was not hashed at either capture, never called unchanged. */
  readonly unmeasured: readonly UnmeasuredPath[];
  readonly startState?: StartState;
  readonly endState?: StartState;
  /**
   * In a folder of Git repositories that is in none (#384), what each unit
   * holds, in name order: each repository the request changed, measured from
   * its own base, with its paths and commands relative to it; and, once a
   * tool may have changed files, each folder in no repository, with nothing
   * verified. The fields above then hold nothing, and `base` is null.
   */
  readonly units?: readonly ReceiptUnit[];
  /**
   * The cases the operator's request leaves open, as a model listed them for
   * the operator to settle (#397): a model's opinion, never evidence. Absent
   * when the operator turned the list off.
   */
  readonly openCases?: OpenCases;
  /** Submitted operator input that qualified the request; neither check evidence nor acceptance. */
  readonly clarifications?: readonly Clarification[];
  /** Context supplied to each model-judged step, with any requests left out for context capacity. */
  readonly requestJudgments?: readonly RequestJudgment[];
  /** The subagents the run started (#525), who did what: each one's own receipt is evidence about its own branch only. */
  readonly children?: readonly ReceiptChild[];
  /** The calls Tesota's floor refused in the request (#622): what didn't run, neither evidence nor a verdict. */
  readonly floorRefusals?: readonly FloorRefusal[];
}

/**
 * A subagent a run started (#525), as its end reported it: what it was
 * asked in a few words, its type and model, whether it wrote, how its run
 * ended, where its own receipt stands, its session, and the branch its work
 * stays on. What it changed counts only once the run brought it in.
 */
export interface ReceiptChild {
  readonly description: string;
  readonly type?: string;
  readonly model?: string;
  readonly writes: boolean;
  readonly outcome: string;
  readonly verification?: "verified" | "incomplete" | "failed";
  readonly session: string;
  readonly branch?: string;
  /** How many of its calls Tesota's floor refused (#622). */
  readonly floorRefusals?: number;
  /** A writing subagent that ran without Git's guard on its branch (#619). */
  readonly unguarded?: true;
}

/**
 * A call Tesota's floor refused in a request (#622): the tool, what it
 * named, cut short, and why. A refusal shows that one call didn't run, not
 * that its effect was prevented, nor that the run broke a rule.
 */
export interface FloorRefusal {
  readonly tool: string;
  readonly subject: string;
  readonly reason: string;
}

/** A model's check and the gate's verdict on it (`gateVerdict`). */
export type ModelResult = ModelCheck & { readonly verdict: GateVerdict };

/** What a receipt records for one repository or folder; the receipt itself is one, for the folder Pi runs in. */
export type UnitEvidence = Pick<Receipt, "repository" | "snapshot" | "tooLarge" | "reason" | "base" | "proofs" | "contracts" |
  "claimcheck" | "tests" | "exercises" | "models" | "unheaded" | "weakened" | "unverified" | "commentsOnly" | "uncovered" | "changed" |
  "lines" | "inherited" | "unmeasured" | "startState" | "endState">;

/** Whether anything verified a unit: it is a Git repository, or Tesota snapshotted it. */
export function verified(unit: Pick<UnitEvidence, "repository" | "snapshot">): boolean {
  return unit.repository || unit.snapshot === true;
}

/**
 * How many assumptions the change added to the files a proof checked
 * (`files`, its TypeScript source and its `.dfy`): an `//@ assume` in the
 * source, or an `assume`, `{:axiom}` or lemma without a body in the `.dfy`,
 * such as each `//@ extern` adds. The proof holds only given them. None when
 * the change could not be read, which the receipt reports instead.
 */
export function addedAssumptions(files: readonly string[], weakened: UnitEvidence["weakened"]): number {
  return typeof weakened === "string" ? 0
    : weakened.filter((change) => change.kind === "added_assume" && files.includes(change.path)).length;
}

/** A unit's evidence and its folder, relative to the folder Pi runs in; empty for that folder's own files. */
export type ReceiptUnit = UnitEvidence & { readonly folder: string };

const none: LineCount = { added: 0, removed: 0 };

/** A change of no lines. */
export const noLines: ChangeLines = { implementation: none, tests: none, other: none, binary: [], generated: [] };

/** Several units' lines as one count; `unreadable` when any unit's was. */
function linesTogether(each: readonly UnitEvidence["lines"][]): UnitEvidence["lines"] {
  const counts = each.filter((lines): lines is ChangeLines => typeof lines !== "string");
  if (counts.length < each.length) return "unreadable";
  const sum = (pick: (lines: ChangeLines) => LineCount): LineCount => ({
    added: counts.reduce((total, lines) => total + pick(lines).added, 0),
    removed: counts.reduce((total, lines) => total + pick(lines).removed, 0) });
  return { implementation: sum(({ implementation }) => implementation), tests: sum(({ tests }) => tests), other: sum(({ other }) => other),
    binary: counts.flatMap(({ binary }) => binary), generated: counts.flatMap(({ generated }) => generated) };
}

/** The evidence of a unit that verified nothing. */
export const noEvidence: Omit<UnitEvidence, "repository" | "snapshot" | "tooLarge" | "reason" | "base" | "claimcheck" |
  "commentsOnly" | "startState" | "endState"> = { proofs: [], contracts: [],
  tests: [], exercises: [], weakened: [], unverified: [], uncovered: [], changed: [], lines: noLines, inherited: [], unmeasured: [] };

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
    ...unit.models === undefined ? {} : { models: unit.models.map((model) => ({ ...model, path: at(model.path), evidence: checked(model.evidence) })) },
    ...unit.unheaded === undefined ? {} : { unheaded: unit.unheaded.map(at) },
    weakened: typeof unit.weakened === "string" ? unit.weakened : unit.weakened.map((change) => ({ ...change, path: at(change.path) })),
    unverified: unit.unverified.map(at),
    inherited: unit.inherited.map(at),
    unmeasured: unit.unmeasured.map((item) => ({ ...item, path: at(item.path) })),
    uncovered: unit.uncovered.map((lines) => ({ ...lines, path: at(lines.path) })),
    changed: typeof unit.changed === "string" ? unit.changed : unit.changed.map((file) => ({ ...file, path: at(file.path) })),
    lines: typeof unit.lines === "string" ? unit.lines : { ...unit.lines, binary: unit.lines.binary.map(at), generated: unit.lines.generated.map(at) },
    ...unit.tooLarge === undefined ? {} : { tooLarge: unit.tooLarge.map(at) } };
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
  const units = receipt.units.filter(verified).map(fromFolder);
  const unread = units.find(({ weakened }) => typeof weakened === "string")?.weakened;
  const changed = units.some((unit) => typeof unit.changed === "string") ? "unreadable" as const
    : units.flatMap((unit) => typeof unit.changed === "string" ? [] : unit.changed);
  const models = units.flatMap((unit) => unit.models ?? []);
  const unheaded = units.flatMap((unit) => unit.unheaded ?? []);
  return { repository: units.length > 0, base: null,
    proofs: units.flatMap(({ proofs }) => proofs), contracts: units.flatMap(({ contracts }) => contracts),
    tests: units.flatMap(({ tests }) => tests), exercises: units.flatMap(({ exercises }) => exercises),
    ...models.length === 0 ? {} : { models }, ...unheaded.length === 0 ? {} : { unheaded },
    weakened: typeof unread === "string" ? unread : units.flatMap(({ weakened }) => typeof weakened === "string" ? [] : weakened),
    unverified: units.flatMap(({ unverified }) => unverified), uncovered: units.flatMap(({ uncovered }) => uncovered), changed,
    lines: linesTogether(units.map(({ lines }) => lines)),
    tooLarge: units.flatMap(({ tooLarge }) => tooLarge ?? []),
    inherited: units.flatMap(({ inherited }) => inherited), unmeasured: units.flatMap(({ unmeasured }) => unmeasured),
    ...units.length > 0 && units.every(({ commentsOnly }) => commentsOnly === true) ? { commentsOnly: true as const } : {} };
}

/**
 * The repository at `folder` of a folder of repositories as a receipt of its
 * own, for a pull request in it, with `folder` kept; nothing when the
 * request did not change it.
 */
export function unitReceipt(receipt: Receipt, folder: string): Receipt | undefined {
  const unit = receipt.units?.find((candidate) => candidate.folder === folder && candidate.repository);
  const { version, startedAt, settledAt, engine, model, clarifications, requestJudgments, openCases, unresolvedQuestion, stopped } = receipt;
  return unit === undefined ? undefined : { ...unit, version, startedAt, settledAt, engine, ...model === undefined ? {} : { model },
    ...clarifications === undefined ? {} : { clarifications }, ...requestJudgments === undefined ? {} : { requestJudgments: requestJudgments.filter((judgment) =>
      judgment.method === "open_cases" || judgment.folder === folder) },
    ...stopped === undefined ? {} : { stopped }, ...openCases === undefined ? {} : { openCases },
    ...unresolvedQuestion === undefined ? {} : { unresolvedQuestion } };
}

/** How a folder in no repository is named: the folder the session runs in holds only its own files there. */
export function plainName(folder: string): string {
  return folder === "" ? "the workspace's own files" : folder;
}

/** Why a folder in no repository was not verified: as Tesota recorded it, or its lack of a repository. */
function plainReason({ folder, reason }: ReceiptUnit): string {
  return reason ?? `${folder === "" ? "they are" : "it is"} in no Git repository, so Tesota cannot tell what changed`;
}

function why(evidence: Evidence): string {
  return evidence.outcome === "timed_out" ? "ran past its time limit" : evidence.outcome === "cancelled"
    ? "was stopped" : `could not run: ${evidence.output.split("\n").at(-1) ?? ""}`;
}

/** A proof that holds only given what the change trusts without proving it (`addedAssumptions`), in plain words (#399). */
const trusting = (assumed: number): string => `trusting ${plural(assumed, "unproved part", "unproved parts")}`;

/**
 * What a proof that holds covers: LemmaScript models `number` as an exact
 * integer or real, never an IEEE 754 double, and leaves out `await` and
 * other features it does not support (LemmaScript's SPEC.md, "Not Yet
 * Supported").
 */
const proofScope = "Proved in LemmaScript's model: numbers are exact integers or reals, not floating-point, so rounding, NaN and Infinity " +
  "aren't covered; nor are await and other unsupported features";

function line(path: string, verdict: GateVerdict, evidence: Evidence, assumed: number): string {
  if (evidence.invalidated === "content_changed") return `  stale         ${path}: ${staleEvidenceWords}`;
  if (verdict === "proved") return `  proved        ${path}${assumed === 0 ? "" : `, ${trusting(assumed)} the change added`}`;
  if (verdict === "operator") return `  NOT proved    ${path}: the proof ${why(evidence)}`;
  const what = evidence.outcome === "vacuous" ? "Dafny verified nothing" : "an obligation fails";
  return `  NOT proved    ${path}: ${what}${verdict === "send_back" ? "; generation ended before repair" : again(evidenceEnd("proof", evidence))}`;
}

/** How a check that went back and came back unchanged ended: failing again only when it ran and failed (`checkEnd`), otherwise still a gap. */
const again = (end: ReturnType<typeof checkEnd>): string =>
  end === "failed" ? ", repeating a failure already sent back" : ", still could not be checked after being sent back";

function testLine({ command, verdict, evidence, failingTests }: Receipt["tests"][number]): string {
  if (evidence.invalidated === "content_changed") return `  stale         ${command}: ${staleEvidenceWords}`;
  if (verdict === "proved") return `  passed        ${command}`;
  if (verdict === "operator") return `  NOT passed    ${command}: it ${why(evidence)}`;
  if (verdict === "send_back") return `  NOT passed    ${command}: it fails; generation ended before repair${failingTests === undefined ? "" : `: ${failingTests.join("; ")}`}`;
  if (failingTests === undefined || failingTests.length === 0) {
    return `  NOT passed    ${command}: it still fails after its failure went back`;
  }
  return `  NOT passed    ${command}: these tests fail, as they did when they went back: ${failingTests.join("; ")}`;
}

/** What was observed of a test against the base, never more: one that notices the change may still expect the wrong thing. */
const sensitivityText: Readonly<Record<TestExercise["sensitivity"], string>> = {
  fails_then_passes: "notices change", passes_on_base: "passes on base", unknown: "not checked  ",
};

/** Who set what a test expects: this request, when it added the test or changed it. */
const provenanceWords: Readonly<Record<TestExercise["provenance"], string>> = {
  added: "added in this request", changed: "changed in this request",
};

/** A test against the base, as one line of words: what it did there, then who set what it expects. */
const exerciseDetail = ({ provenance, reason }: TestExercise, attributable: boolean): string =>
  `${reason}; ${attributable ? provenanceWords[provenance] : "contribution unresolved"}`;

/** The change's lines by category in one row, when it changed any; a summary of the diff, not of what was verified. */
function linesRow(lines: UnitEvidence["lines"]): string[] {
  if (lines === "unreadable") return ["  changed lines not counted: Git could not show the change, or a file could not be read"];
  const counts = (["implementation", "tests", "other"] as const).flatMap((category) => {
    const { added, removed } = lines[category];
    return added + removed === 0 ? [] : [`${category} +${added} -${removed}`];
  });
  const files = (count: number, kind: string): string[] => count === 0 ? [] : [`${count} ${kind} ${count === 1 ? "file" : "files"}`];
  const binary = files(lines.binary.length, "binary");
  return counts.length + binary.length === 0 ? []
    : [`  changed lines ${[...counts, ...binary, ...files(lines.generated.length, "generated")].join(" · ")}`];
}

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

/**
 * What an added assumption trusts without proof, in plain words read from
 * the line as written: the function an `//@ extern` or `{:axiom}` trusts, a
 * lemma left without a body, or the condition an `assume` takes as true.
 * Dafny assumes an `{:axiom}`'s postcondition "to be true without proof"
 * (Dafny Reference Manual, `{:axiom}`).
 */
export function trustedWords({ annotation, function: trusted }: { readonly annotation: string; readonly function?: string }): string {
  const named = trusted ?? /\{:axiom\}\s*([\w'?$]+)/u.exec(annotation)?.[1];
  if (named !== undefined) return `trusts ${named} without proving it`;
  if (/^\/\/@\s*extern\b/u.test(annotation)) return "trusts a function without proving it";
  const lemma = /^lemma (\S+) without a body$/u.exec(annotation)?.[1];
  if (lemma !== undefined) return `takes lemma ${lemma} as true without proving it`;
  const condition = /^(?:\/\/@\s*)?assume\s+(.+?);?$/u.exec(annotation)?.[1]?.trim();
  return condition === undefined || condition === "" ? "takes something as true without proving it"
    : `takes ${condition} as true without proving it`;
}

/**
 * What an added `//@ skip` leaves out of the proof, in plain words: the unit
 * it names, or a statement of the unit that holds it. LemmaScript omits
 * either from the program it generates, so nothing proves it.
 */
export function skippedWords({ function: unit, statement }: { readonly function?: string; readonly statement?: true }): string {
  if (unit === undefined) return statement === true ? "leaves a statement out of the proof" : "leaves something out of the proof";
  return statement === true ? `leaves a statement of ${unit} out of the proof` : `leaves ${unit} out of the proof`;
}

/** What a test edit may have done to one test (`TestEdit`), in plain words. */
function testEditWords(edit: TestEdit): string {
  switch (edit.kind) {
    case "removed_assertion": return `removes ${edit.assertion}`;
    case "loosened_assertion": return `loosens ${edit.subject}.${edit.before} to .${edit.after}`;
    case "dropped_not": return `drops the not of ${edit.subject}.${edit.before}, now .${edit.after}`;
    case "changed_assertion": return `changes ${edit.before} to ${edit.after}`;
    case "skipped": return `skips it (${edit.marker})`;
    case "focused": return `focuses it (${edit.marker}), so the file's other tests do not run`;
    case "mocked_subject": return `mocks ${edit.module}, the module the file tests`;
    case "deleted_test": return "deletes it";
  }
}

/** How many tests a test edit's flag names, so it reads in seconds; the receipt's JSON keeps them all. */
const TESTS_SHOWN = 10;

/** One line per test a test edit may weaken, up to `TESTS_SHOWN`: the test, then what the edit did to it. */
function testLines(tests: readonly WeakenedTest[]): string[] {
  const rest = tests.length - TESTS_SHOWN;
  return [...tests.slice(0, TESTS_SHOWN).map(({ test, edits }) => `${test ?? "outside any test"}: ${edits.map(testEditWords).join("; ")}`),
    ...rest > 0 ? [`and ${plural(rest, "more test", "more tests")}`] : []];
}

/** What the receipt says a test edit does when it says how it may weaken each test: a heuristic reading, never a verdict. */
const testEditHead = "edits a test file; read from the diff, a heuristic flag, not a verdict";

function weakening(change: Weakening): string[] {
  const tests = change.kind === "edited_test" ? change.tests ?? [] : [];
  const what = change.kind === "removed_contract" ? `removes or changes ${change.annotation}`
    : change.kind === "added_requires" ? `adds ${change.annotation} to a function the base had`
    : change.kind === "added_assume" ? `${trustedWords(change)} (${change.annotation})`
    : change.kind === "added_skip" ? `${skippedWords(change)} (${change.annotation})`
    : change.kind === "changed_check_script" ? `${weakeningWords[change.kind]} ${change.script}`
      : change.kind === "deleted_test" ? "deletes a test file" : tests.length > 0 ? testEditHead : "edits a test file";
  return [`  may weaken    ${change.path}: ${what}`, ...testLines(tests).map((line) => `                ${line}`)];
}

/** Whether a session entry's details hold a receipt this Tesota reads. */
export function isReceipt(value: unknown): value is Receipt {
  // A receipt from before the engine named itself (#463) has `pi` in place of `engine`: an earlier Tesota's.
  return typeof value === "object" && value !== null && Reflect.get(value, "version") === 2 && typeof Reflect.get(value, "engine") === "string";
}

/** A session entry that may carry a receipt: a message, or a custom entry from print mode. */
export interface ReceiptEntry { readonly type: string; readonly customType?: string; readonly details?: unknown; readonly data?: unknown }

/**
 * What a `tesota-receipt` entry carries, or `undefined` for any other entry:
 * a message's details, or a custom entry's data from print mode (#427).
 */
export function entryReceipt(entry: ReceiptEntry): unknown {
  if (entry.customType === "tesota-receipt-graphs" && entry.type === "custom_message" && typeof entry.details === "object" && entry.details !== null) {
    return Reflect.get(entry.details, "receipt");
  }
  if (entry.customType !== "tesota-receipt") return undefined;
  return entry.type === "custom_message" ? entry.details : entry.type === "custom" ? entry.data : undefined;
}

/**
 * The entry a run settles with: a message chat hosts show beside the
 * conversation. Pi's print mode writes the final answer only when it is the
 * session's last message, so there the receipt is a custom entry outside the
 * conversation. Temporary (#427): remove the print branch, and the custom
 * entry in `entryReceipt`, once Pi prints the final assistant text after
 * extension messages.
 */
export function receiptEntry(mode: string | undefined, receipt: Receipt):
  { type: "custom"; customType: "tesota-receipt"; data: Receipt } |
  { type: "custom_message"; customType: "tesota-receipt"; content: string; display: true; details: Receipt } {
  return mode === "print" ? { type: "custom", customType: "tesota-receipt", data: receipt }
    : { type: "custom_message", customType: "tesota-receipt", content: renderReceiptMessage(receipt), display: true, details: receipt };
}

/** Transcript metadata, kept outside receipt v2 and its exported evidence. */
export interface ReceiptGraph { readonly subject: string; readonly capture?: GraphCapture; }
export interface ReceiptGraphMessage { readonly receipt: Receipt; readonly graphs: readonly ReceiptGraph[]; }

/** The graphs a session's receipts carry, the newest receipt's first. */
export function entryGraphs(entries: readonly ReceiptEntry[]): ReceiptGraph[] {
  return [...entries].reverse().flatMap((entry) => {
    const graphs = entry.customType === "tesota-receipt-graphs" && entry.type === "custom_message" && typeof entry.details === "object" && entry.details !== null
      ? Reflect.get(entry.details, "graphs") : undefined;
    return Array.isArray(graphs) ? graphs as ReceiptGraph[] : [];
  });
}

/** A message of a session's history, as `sessionGraphs` reads it. */
export interface HistoryMessage { readonly role: string; readonly customType?: string; readonly toolName?: string; readonly details?: unknown }

/**
 * The graphs a session captured, newest first, each capture once: what `/graph` opens. Its receipts carry some, but a
 * run that ends without a receipt, such as a read-only request, and print mode's receipt v2 carry none, so each
 * `check_model` result's own capture counts too.
 */
export function sessionGraphs(messages: readonly HistoryMessage[]): ReceiptGraph[] {
  const seen = new Set<string>();
  return [...messages].reverse().flatMap((message): ReceiptGraph[] => {
    if (message.role === "custom") return entryGraphs([{ ...message, type: "custom_message" }]);
    if (message.role !== "toolResult" || message.toolName !== "check_model" || typeof message.details !== "object" || message.details === null) return [];
    const { path, capture } = message.details as { path?: unknown; capture?: GraphCapture };
    return capture === undefined ? [] : [{ subject: typeof path === "string" ? path : "model", capture }];
  }).filter(({ capture }) => {
    if (capture?.status !== "captured") return true;
    if (seen.has(capture.manifest)) return false;
    seen.add(capture.manifest);
    return true;
  });
}

/** A graph-bearing transcript message; print mode still records only receipt v2. */
export function receiptGraphEntry(mode: string | undefined, receipt: Receipt, graphs: readonly ReceiptGraph[]):
  ReturnType<typeof receiptEntry> | { type: "custom_message"; customType: "tesota-receipt-graphs"; content: string; display: true; details: ReceiptGraphMessage } {
  return mode === "print" || graphs.length === 0 ? receiptEntry(mode, receipt) : { type: "custom_message", customType: "tesota-receipt-graphs",
    content: renderReceiptMessage(receipt), display: true, details: { receipt, graphs } };
}

/** Which check a finding comes from. */
export type Check = "proof" | "tests" | "model" | "weakening" | "contract" | "exercise" | "request" | "coverage";

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
  /** How the receipt's summary groups it with findings of the same reason (#591); without one, by its label and detail. */
  readonly group?: FindingGroup;
  /** Said for information only, shown muted: neither a check that held nor a limit, such as a covered file no proof covers. */
  readonly muted?: true;
}

/**
 * A group of the summary (#591): its title, with `%` for how many of `noun`
 * when it counts them, or else followed by the one finding's subject or the
 * count; the note under it, the reason its findings share; and what the
 * finding adds to the group's list of paths.
 */
export interface FindingGroup {
  readonly title: string;
  readonly noun?: readonly [string, string];
  readonly note: string;
  readonly item?: string;
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

/**
 * How a proof or command ended (`checkEnd`, proved), from its evidence:
 * `failed` only when it ran and showed the change wrong, a gap when it
 * couldn't run, checked nothing or is stale. A model's run is not read.
 */
export const evidenceEnd = (kind: "proof" | "command", evidence: Evidence): ReturnType<typeof checkEnd> =>
  checkEnd(kind, evidence.invalidated !== undefined, evidence.outcome, "not_started", false);

/** How a design model ended (`checkEnd`): `failed` only on an observed violation or a planted fault it didn't catch. */
export const modelEnd = ({ evidence, run, faults }: Pick<ModelResult, "evidence" | "run" | "faults">): ReturnType<typeof checkEnd> =>
  checkEnd("model", evidence.invalidated !== undefined, evidence.outcome, run, faults.some(({ verdict }) => verdict === "passes"));

/** A command's run as a finding: passed, still failing after it went back, or a gap because it did not run or is stale. */
export function commandFinding({ command, verdict, evidence, failingTests }: Pick<Receipt["tests"][number],
  "command" | "verdict" | "evidence" | "failingTests">): Finding {
  const more = [`Ran in ${seconds(evidence.durationMs)} · sha256 ${evidence.contentHash.slice(0, 12)}`];
  if (evidence.invalidated === "content_changed") {
    return { standing: "gap", check: "tests", label: "Tests stale", subject: command, detail: staleEvidenceWords, more };
  }
  const end = evidenceEnd("command", evidence);
  if (end === "passed" && verdict === "proved") return { standing: "holds", check: "tests", label: "Tests pass", subject: command, detail: "", more };
  if (end !== "failed") {
    return { standing: "gap", check: "tests", label: "Tests did not run", subject: command, detail: `it ${why(evidence)}`, more };
  }
  return { standing: "decide", check: "tests", failed: true, label: "Tests fail", subject: command,
    detail: failingTests === undefined || failingTests.length === 0 ? "the command fails"
      : `${plural(failingTests.length, "test fails", "tests fail")}: ${failingTests.join("; ")}`, more };
}

/** A counterexample as numbered steps in words, in the model's names, for the agent and the receipt. */
export function counterexampleSteps({ steps }: Counterexample): string[] {
  return steps.map(({ action, changes }, k) => `${k + 1}. ${action}${changes.length === 0 ? ", changing nothing" : `: ${changes.join(", ")}`}`);
}

export const linkWords: Readonly<Record<ModelLink, string>> = {
  linked: "linked to the code by its trace replay", no_replay: "not linked to the code", replay_failed: "not linked to the code: its replay fails",
};

/** What a model passing establishes, in one phrase: its invariants in every reachable state, and its faults caught. */
export function modelHolds({ header, states, faults }: ModelCheck): string {
  const caught = faults.filter(({ verdict }) => verdict === "caught").length;
  return `${header.invariants.join(", ")} ${header.invariants.length === 1 ? "holds" : "hold"} in all ` +
    `${plural(states, "reachable state", "reachable states")}; caught ${caught} of ${plural(faults.length, "planted fault", "planted faults")}`;
}

/** What a model declares it covers and abstracts, which fixes what it can find (#539). */
function abstractionWords({ header }: ModelCheck): string[] {
  return [`Covers ${header.covers.map(({ path, names }) => names.length === 0 ? path : `${path} (${names.join(", ")})`).join("; ")}`,
    ...header.atomic.map((step) => `Atomic: ${step}`), ...header.omits.map((left) => `Leaves out: ${left}`)];
}

/** Why a model's check did not finish or could not run, from how it ended. */
export function modelWhy({ run, problems, evidence }: ModelCheck): string {
  if (run === "timed_out") return "TLC ran past its time limit";
  if (run === "cancelled") return "the check was stopped";
  const lines = evidence.output.trim().split(/\r?\n/u);
  // A run that did not start says why first; TLC reports an error before its closing lines.
  return problems[0] ?? (run === "not_started" ? lines[0] : lines.find((line) => /^Error: |error:/iu.test(line)) ?? lines.at(-1)) ?? "";
}

/** The planted faults that pass or could not be checked, which make a passing model too weak to trust. */
function failingFaults({ faults }: ModelCheck): string {
  const failing = faults.filter(({ verdict }) => verdict === "passes" || verdict === "broken");
  return failing.length === 0 ? "no planted fault shows it can fail"
    : `${failing.map(({ path, verdict }) => `${path} ${verdict === "passes" ? "passes" : "could not be checked"}`).join(", ")}`;
}

/** Whether a model may no longer describe its code, as a gap; nothing when it is current. */
function stalenessFindings({ path, staleness, stale, header }: ModelCheck): Finding[] {
  if (staleness === "current") return [];
  if (staleness === "possibly_stale") {
    return [{ standing: "gap", check: "model", label: "Model possibly stale", subject: path,
      detail: `${stale.join(", ")} changed since ${header.confirmed?.slice(0, 12) ?? ""}, the commit it was confirmed against`, more: [] }];
  }
  return [{ standing: "gap", check: "model", label: "Model staleness unknown", subject: path,
    detail: header.confirmed === undefined ? "its header names no confirmed commit" : `commit ${header.confirmed} is not in the repository`, more: [] }];
}

/** A model's check as its main finding: model-checked, not checked, failing, too weak, or unreadable to TLC. */
export function modelFinding(model: ModelResult): Finding {
  const { path, verdict, counterexample, faults, writtenWithCode } = model;
  const more = [...abstractionWords(model), ...faults.map((fault) => `Fault ${fault.path} (${fault.description}): ${fault.verdict}`),
    checked(model.evidence)];
  if (verdict === "proved") {
    return { standing: "holds", check: "model", label: writtenWithCode ? "Model-checked, written with the code" : "Model-checked", subject: path,
      detail: `${modelHolds(model)}; ${linkWords[model.link]}`, more };
  }
  if (verdict === "operator") return { standing: "gap", check: "model", label: "Model not checked", subject: path, detail: modelWhy(model), more };
  // Only an observed violation or a planted fault it didn't catch fails (`modelEnd`); a model that couldn't be checked is a gap.
  if (modelEnd(model) !== "failed") {
    return { standing: "gap", check: "model", label: model.run === "passed" ? "Model too weak" : "Model not checkable", subject: path,
      detail: model.run === "passed" ? failingFaults(model) : modelWhy(model), more };
  }
  if (counterexample !== undefined) {
    return { standing: "decide", check: "model", failed: true, label: "Model fails", subject: path, detail: counterexample.violation,
      more: [...counterexampleSteps(counterexample), ...more] };
  }
  return model.run === "passed"
    ? { standing: "decide", check: "model", failed: true, label: "Model too weak", subject: path, detail: failingFaults(model), more }
    : { standing: "decide", check: "model", failed: true, label: "Model fails", subject: path, detail: modelWhy(model), more };
}

/**
 * Each model as findings (#551): model-checked when it and every planted
 * fault behaved, marked weaker when the request wrote it with its code; a
 * decision when it still fails or its faults pass after going back; a gap
 * when it could not be checked, a fault did not finish, it may be stale, or a
 * changed file declares no header. Model-checked is about the model: the
 * receipt says whether a replay links it to the code.
 */
function modelFindings(models: readonly ModelResult[], unheaded: readonly string[]): Finding[] {
  return [...models.flatMap((model) => [modelFinding(model),
    ...model.verdict !== "proved" ? [] : model.faults.filter(({ verdict }) => verdict === "unrun").map((fault): Finding => ({ standing: "gap",
      check: "model", label: "Planted fault not checked", subject: fault.path, detail: fault.output.trim().split(/\r?\n/u).at(-1) ?? "", more: [] })),
    ...stalenessFindings(model)]),
  ...unheaded.map((path): Finding => ({ standing: "gap", check: "model", label: "Model not checked", subject: path,
    detail: "it declares no tesota-model header", more: [] }))];
}

/** A model's lines of the receipt. */
function modelLines(model: ModelResult): string[] {
  const { path, verdict, counterexample } = model;
  const abstraction = abstractionWords(model).map((words) => `                ${words}`);
  const stale = stalenessFindings(model).map(({ detail }) => `  ${model.staleness === "unknown" ? "staleness?    " : "may be stale  "}${path}: ${detail}`);
  if (verdict === "proved") {
    return [`  model-checked ${path}: ${modelHolds(model)}; ${linkWords[model.link]}${model.writtenWithCode ? "; written with the code, so weaker" : ""}`,
      ...abstraction, `                content sha256 ${model.evidence.contentHash}`, ...stale];
  }
  if (verdict === "operator") return [`  not checked   ${path}: ${modelWhy(model)}`, ...stale];
  const unrepaired = "; generation ended before repair";
  if (counterexample !== undefined) {
    return [`  model fails   ${path}: ${counterexample.violation}${verdict === "send_back" ? unrepaired : ", repeating a counterexample already sent back"}`,
      ...counterexampleSteps(counterexample).map((step) => `                ${step}`), ...abstraction, ...stale];
  }
  const repeated = modelEnd(model) === "failed" ? undefined : again("gap");
  return [model.run === "passed" ? `  weak model    ${path}: ${failingFaults(model)}${verdict === "send_back" ? unrepaired : repeated ?? ", after they went back"}`
    : `  NOT checked   ${path}: ${modelWhy(model)}${verdict === "send_back" ? unrepaired : repeated ?? again("failed")}`, ...stale];
}

/**
 * A proof as a finding. One that holds only given parts the change trusts
 * without proving them (`assumed`) says how many, so it never reads as
 * proved outright (#399).
 */
export function proofFinding({ path, verdict, evidence }: Pick<Receipt["proofs"][number], "path" | "verdict" | "evidence">,
  assumed = 0): Finding {
  const summary = proofSummary(evidence);
  if (verdict === "proved") {
    return { standing: "holds", check: "proof", label: assumed === 0 ? "Proved" : `Proved, ${trusting(assumed)}`,
      subject: path, detail: assumed === 0 ? summary.words : "its contracts hold only if what the change trusts is right",
      more: [checked(evidence)] };
  }
  const more = [...summary.at === undefined ? [] : [`at ${summary.at}`], checked(evidence)];
  // A proof that could not run, verified nothing or is stale shows nothing about the change: a gap (`evidenceEnd`).
  if (evidenceEnd("proof", evidence) !== "failed") {
    return { standing: "gap", check: "proof", label: evidence.invalidated === "content_changed" ? "Proof stale"
      : evidence.outcome === "vacuous" ? "Proof proved nothing" : "Proof did not run", subject: path, detail: summary.words, more };
  }
  return { standing: "decide", check: "proof", failed: true, label: "Proof fails", subject: path, detail: summary.words, more };
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
      detail: `ClaimCheck ${run.reason}`, more: [],
      group: { title: "ClaimCheck did not compare the contracts with the request", note: `ClaimCheck ${run.reason}` } }];
  }
  const by = run.restatedBy === run.comparedBy ? `${run.comparedBy} restated and compared`
    : `${run.restatedBy} restated, ${run.comparedBy} compared`;
  return contracts.flatMap(({ path, name, judgment }): Finding[] => judgment === undefined ? [] : [{ standing: "opinion",
    check: "request", label: judgment.verdict === "justified" ? "Model: matches" : "Model: partial match",
    subject: `${name} · ${path}`, detail: judgmentWords[judgment.verdict],
    more: [judgment.explanation, `A model's opinion, not a proof: ${by}.`],
    group: { title: `ClaimCheck: ${judgmentWords[judgment.verdict]}`, note: "", item: `${name} · ${path}` } }]);
}

/** The results someone could expect from an open case, as one phrase: models end each with a full stop. */
function either(outcomes: readonly string[]): string {
  return outcomes.map((outcome) => outcome.trim().replace(/\.$/u, "")).join(" or ");
}

/** The cases a model listed as left open by the request, one opinion each, for the operator to settle. */
function openCaseFindings(listed: OpenCases | undefined): Finding[] {
  if (listed === undefined) return [];
  if (listed.status === "not_listed") {
    return [{ standing: "opinion", check: "request", label: "Not listed", subject: "the cases the request leaves open", detail: listed.reason, more: [],
      group: { title: "Open cases not listed", note: listed.reason } }];
  }
  return listed.cases.map(({ input, outcomes }) => ({ standing: "opinion", check: "request", label: "Model: open case", subject: input,
    detail: either(outcomes), more: [`A model's list for you to settle, not a check: ${listed.model}.`],
    group: { title: `% for you to settle, listed by ${listed.model}`, noun: ["open case", "open cases"], note: "",
      item: `${input}: ${either(outcomes)}` } }));
}

/** The receipt's lines for the open cases a model listed, labelled a model's opinion. */
function openCaseLines(listed: OpenCases | undefined): string[] {
  if (listed === undefined) return [];
  if (listed.status === "not_listed") return [`  not listed    the cases the request leaves open: ${listed.reason}`];
  if (listed.cases.length === 0) return [`  model listed  no case the request leaves open, by ${listed.model}; a model's opinion, not a check`];
  return [`  model listed  by ${listed.model}, cases the request may leave open, for you to settle; a model's opinion, not a check:`,
    ...listed.cases.map(({ input, outcomes }) => `                ${input}: ${either(outcomes)}`)];
}

/** Whether an opinion is a note for the operator: a model finding a contract short of the request, or a case it leaves open. */
export function isNote(finding: Finding): boolean {
  return finding.standing === "opinion" && (finding.label === "Model: partial match" || finding.label === "Model: open case");
}

const weakeningWords: Readonly<Record<Weakening["kind"], string>> = {
  removed_contract: "removes or changes a contract line", added_requires: "adds a precondition to a function the base had",
  added_assume: "trusts something without proving it", added_skip: "leaves something out of the proof",
  deleted_test: "deletes a test file", edited_test: "edits a test",
  changed_check_script: "changes the command or selection of check script",
};

/** What the summary asks the operator to review for each kind of change that may weaken the evidence: a heuristic, never a confirmed weakening. */
const reviewTitles: Readonly<Record<Weakening["kind"], string>> = {
  removed_contract: "Review removed or changed contracts", added_requires: "Review added preconditions",
  added_assume: "Review added assumptions", added_skip: "Review parts left out of proofs",
  deleted_test: "Review deleted tests", edited_test: "Review test edits", changed_check_script: "Review check script changes",
};

/** A test's reason against the base (`exercise` in test-rung.ts) in fewer words, for the summary; the details keep it whole. */
const shortReasons: Readonly<Record<string, string>> = {
  "on the base it failed, but so does the base without it, and no test report says which tests fail": "Base fails too; no per-test failure report.",
};

/** A reason in fewer words when it starts with one `shortReasons` knows, whatever it adds after, such as which check ran it. */
const shortReason = (reason: string): string =>
  Object.entries(shortReasons).find(([long]) => reason.startsWith(long))?.[1] ?? reason;

/**
 * The receipt's findings for people: everything it records, each with what
 * it asks of the operator. A model's judgment is an `opinion`: shown, never
 * counted (`decisions`).
 */
export function receiptFindings(receipt: Receipt): Finding[] {
  if (receipt.stopped !== undefined) {
    return [{ standing: "decide", check: "coverage", label: "Not verified", subject: "this request's changes",
      detail: receipt.stopped, more: [] }];
  }
  return [...receipt.unresolvedQuestion === undefined ? [] : [{ standing: "decide" as const, check: "request" as const,
    label: "Incomplete", subject: "unresolved question", detail: receipt.unresolvedQuestion, more: [] }],
  ...receipt.units === undefined ? unitFindings(receipt) : receipt.units.flatMap((unit) => verified(unit)
    ? unitFindings(fromFolder(unit), unit.folder) : [{ standing: "decide" as const, check: "coverage" as const, label: "Not verified",
      subject: plainName(unit.folder), detail: plainReason(unit), more: [] }]), ...openCaseFindings(receipt.openCases)];
}

/** One unit's findings, from the folder Pi runs in; each unit's tests decide how its unproved files are worded. */
function unitFindings(receipt: UnitEvidence, folder = ""): Finding[] {
  if (!verified(receipt)) {
    return [{ standing: "decide", check: "coverage", label: "Not verified", subject: "this request's changes",
      detail: receipt.reason ?? "the project has no Git repository, so Tesota cannot tell which files changed", more: [] }];
  }
  const tested = receipt.tests.length > 0 && receipt.tests.every(({ verdict }) => verdict === "proved");
  const unproved = tested ? "Not proved" : "Not verified";
  const covered = coveredPaths(receipt);
  const unread = typeof receipt.weakened === "string";
  const found: Finding[] = [
    ...fingerprintFindings(receipt, folder),
    ...receipt.proofs.map((proof) => proofFinding(proof, addedAssumptions(proof.evidence.files, receipt.weakened))),
    ...receipt.tests.map(commandFinding),
    ...modelFindings(receipt.models ?? [], receipt.unheaded ?? []),
    ...typeof receipt.weakened === "string"
      ? [{ standing: "decide" as const, check: "weakening" as const, label: "Weakening not checked", subject: "the change",
        detail: (receipt.weakened === "too_large" ? "it is too large to check for weakening" : "Git could not show it"), more: [] }]
      : receipt.weakened.map((change): Finding => {
        const detail = (change.kind === "added_assume" ? trustedWords(change)
          : change.kind === "added_skip" ? skippedWords(change)
          : change.kind === "changed_check_script" ? `${weakeningWords[change.kind]} ${change.script}` : weakeningWords[change.kind]);
        return { standing: "decide", check: "weakening", label: "May weaken the evidence", subject: change.path, detail,
          more: "annotation" in change ? [change.annotation] : change.kind === "edited_test" ? testLines(change.tests ?? []) : [],
          group: { title: `${reviewTitles[change.kind]} · %`,
            noun: ["heuristic flag", "heuristic flags"], note: "May weaken evidence; not confirmed weakening" + ".", item: `${change.path}: ${detail}` } };
      }),
    ...receipt.contracts.map(contractFinding),
    ...receipt.exercises.map((exercise): Finding => {
      const { path, sensitivity, reason } = exercise;
      const detail = exerciseDetail(exercise, resolved(receipt));
      const testFiles = ["test file", "test files"] as const;
      return sensitivity === "fails_then_passes"
        ? { standing: "holds", check: "exercise", label: "Test notices the change", subject: path, detail, more: [] }
        : sensitivity === "passes_on_base"
          ? { standing: "decide", check: "exercise", label: "Test passes on base", subject: path, detail, more: [],
            group: { title: "Test passes without the change · %", noun: testFiles, note: reason, item: path } }
          : { standing: "gap", check: "exercise", label: "Test not checked", subject: path, detail, more: [],
            group: { title: "Change sensitivity unknown · %", noun: testFiles, note: shortReason(reason), item: path } };
    }),
    ...opinionFindings(receipt.claimcheck, receipt.contracts),
    ...unread && receipt.proofs.length > 0
      ? [{ standing: "gap" as const, check: "coverage" as const, label: "Coverage not checked", subject: "the changed lines",
        detail: "for the same reason", more: [] }] : [],
    ...receipt.uncovered.filter(({ lines }) => lines.length > 0).map(({ path, lines }): Finding => {
      const subject = `${path} ${lines.length === 1 && lines[0]?.[0] === lines[0]?.[1] ? "line" : "lines"} ` +
        lines.map(([start, end]) => start === end ? `${start}` : `${start}–${end}`).join(", ");
      return { standing: "gap", check: "coverage", label: unproved, subject,
        detail: (tested ? "outside any contract; the tests pass with them" : "outside any contract, and nothing checked them"), more: [],
        group: { title: "No proof covers changed lines in %", noun: ["file", "files"], note: tested ? "" : "Not checked by anything else.", item: subject } };
    }),
    // A file the standing counts as covered, tested and exercised, is no limit; the receipt still says no proof covers it.
    ...receipt.unverified.map((path): Finding => covered.has(path)
      ? { standing: "holds", check: "coverage", label: "Tested and exercised", subject: path, detail: "no proof covers it", more: [],
        muted: true, group: { title: `${path}: tested and exercised; no proof covers it`, note: "" } }
      : { standing: "gap", check: "coverage", label: unproved, subject: path,
        detail: (tested ? "no contract; the tests pass with it" : "nothing checked it"), more: [],
        group: { title: "No proof covers %", noun: ["changed file", "changed files"], note: tested ? "" : "Not checked by anything else.", item: path } }),
    ...(receipt.tooLarge ?? []).map((path): Finding => ({ standing: "gap", check: "coverage", label: "Not verified", subject: path,
      detail: "too large for Tesota's snapshot, which left it out", more: [],
      group: { title: "Left out of Tesota's snapshot · %", noun: ["file too large", "files too large"], note: "Not verified by anything.",
        item: path } })),
  ];
  // A change of comments alone leaves nothing to list; the receipt says so rather than ending empty.
  return found.length === 0 && receipt.commentsOnly === true ? [{ standing: "holds", check: "coverage",
    label: "Nothing to verify", subject: "", detail: "the changes are comments or blank lines only", more: [] }] : found;
}

function resolved(receipt: UnitEvidence): boolean {
  return attributionResolved(receipt.base, receipt.startState, receipt.endState, receipt.repository && receipt.snapshot !== true);
}

/** Attribution limits affect what is known, never the inherited paths' status or the checks' evidence. */
function fingerprintFindings(receipt: UnitEvidence, folder = ""): Finding[] {
  const measurements = receipt.exercises.length > 0 || receipt.contracts.length > 0 || receipt.claimcheck !== undefined
    ? "recorded exercise and contract measurements do not establish request attribution"
    : "test exercise, contract strength and ClaimCheck were not measured";
  return [...resolved(receipt) ? [] : [{ standing: "gap" as const, check: "coverage" as const,
    label: "Attribution unresolved", subject: folder, detail: `${folder === "" ? "" : `${folder}: `}history moved, could not be read, or was not captured; ${measurements}. Changes are compared with the request's start, not attributed to this request`, more: [] }],
  ...([receipt.startState, receipt.endState] as const).flatMap((state, k): Finding[] => state?.status !== "unknown" ? []
    : [{ standing: "gap", check: "coverage", label: k === 0 ? "Unknown start state" : "Unknown end state", subject: "",
      detail: `${state.reason}; verification compares against the admission base`, more: [] }]),
  ...receipt.unmeasured.map(({ path, reason }): Finding => ({ standing: "gap", check: "coverage", label: "Unmeasured", subject: path,
    detail: reason, more: [] }))];
}

/**
 * What holds, in words for one row: each label once, with how many when more
 * than one, and out of how many findings of its check when some of them do
 * not hold (`partlyHolds`), as in "Contract strong (1 of 4)", so the row
 * never reads stronger than the findings it sums up (#399).
 */
export function holdsWords(findings: readonly Finding[]): string[] {
  const counts = new Map<string, { readonly check: Check; count: number }>();
  for (const { standing, label, check } of findings) {
    if (standing !== "holds") continue;
    const counted = counts.get(label);
    if (counted === undefined) counts.set(label, { check, count: 1 });
    else counted.count += 1;
  }
  return [...counts].map(([label, { check, count }]) => {
    const ofCheck = findings.filter((finding) => finding.check === check).map(({ standing }) => standing);
    return partlyHolds(ofCheck) ? `${label} (${count} of ${ofCheck.length})` : count === 1 ? label : `${label} (${count})`;
  });
}

/** How many of the receipt's findings need the operator; none makes it clean, in the footer and the conversation alike. */
export function receiptDecisions(receipt: Receipt): number {
  return decisions(receiptFindings(receipt).map(({ standing }) => standing));
}

/** The receipt's color (`verdictTone`), from its findings, in the footer and the conversation alike. */
export function receiptTone(findings: readonly Finding[]): ReturnType<typeof verdictTone> {
  return verdictTone(decisions(findings.map(({ standing }) => standing)),
    findings.some(({ standing, failed }) => standing === "decide" && failed === true), findings.filter(({ standing }) => standing === "gap").length);
}

/** Where a receipt stands (`runStanding`), in one word for every surface that shows it (#455, #668). */
export type ReceiptStanding = ReturnType<typeof runStanding>;

/** Each standing as every surface words it: nothing changed claims nothing, so it says there is nothing to verify. */
export const standingWords: Readonly<Record<ReceiptStanding, string>> = {
  verified: "verified", incomplete: "incomplete", failed: "failed", unverified: "unverified", unchanged: "nothing to verify",
};

/** Whether `value` names a standing, as a child's report carries it. */
export function isStanding(value: unknown): value is ReceiptStanding {
  return typeof value === "string" && Object.hasOwn(standingWords, value);
}

/** Why an `unverified` receipt verified nothing, in a few words. */
export function unverifiedWhy(receipt: Receipt): string {
  return allEvidence(receipt).commentsOnly === true ? "the changes are comments or blank lines only"
    : "no test, proof or model check passed on the change";
}

/** The receipt with no unit listing an unproved file, so its findings hold every gap but those (`runStanding` weighs them per path). */
function withoutUnproved(receipt: Receipt): Receipt {
  return receipt.units === undefined ? { ...receipt, unverified: [] }
    : { ...receipt, units: receipt.units.map((unit) => ({ ...unit, unverified: [] })) };
}

/** One changed path of a verified unit as `runStanding` weighs it. */
interface ChangedPath { readonly path: string; readonly proved: boolean; readonly tested: boolean; readonly exercised: boolean }

/**
 * Each path a verified unit records as changed, read per unit, never
 * guessing for verified: proved unless its `unverified` lists it; tested
 * when the unit ran a command and every one passed; exercised when the unit
 * lists exactly that one path unproved, records an exercise, and every
 * exercise is `fails_then_passes`.
 */
function changedPaths(unit: UnitEvidence): ChangedPath[] {
  const tested = unit.tests.length > 0 && unit.tests.every(({ verdict }) => verdict === "proved");
  const noticed = unit.exercises.length > 0 && unit.exercises.every(({ sensitivity }) => sensitivity === "fails_then_passes");
  // Every path the receipt records as changed: the inventory, and each file it lists unproved, proved, with lines uncovered, or modeled.
  const changed = [...typeof unit.changed === "string" ? [] : unit.changed.map(({ path }) => path), ...unit.unverified,
    ...unit.proofs.map(({ path }) => path), ...unit.uncovered.map(({ path }) => path), ...(unit.models ?? []).map(({ path }) => path)];
  return [...new Set(changed)].map((path) => ({ path, proved: !unit.unverified.includes(path), tested,
    exercised: noticed && unit.unverified.length === 1 && unit.unverified[0] === path }));
}

/** The unit's unproved files that are covered all the same (`pathCovered`, as the standing reads them): tested and exercised. */
function coveredPaths(unit: UnitEvidence): ReadonlySet<string> {
  return new Set(changedPaths(unit).filter(({ proved, tested, exercised }) => !proved && pathCovered(proved, tested, exercised))
    .map(({ path }) => path));
}

/** How many unproved files the receipt counts as covered, every unit's together (`coveredPaths`), so none is counted as a limit. */
export function coveredCount(receipt: Receipt): number {
  return receiptUnits(receipt).filter(verified).map(fromFolder).reduce((sum, unit) => sum + coveredPaths(unit).size, 0);
}

/**
 * The receipt's standing (`runStanding`, proved) from what it records: each
 * verified unit's changed paths, read per unit, never guessing for verified;
 * whether anything changed, from those paths, an unreadable inventory or a
 * change of comments alone; the proofs, commands and models that passed on
 * current content; whether one ran and showed the change wrong
 * (`checkEnd`), one that couldn't be checked or is stale being a gap; its other gaps, an unreadable
 * inventory among them; what needs the operator; and whether it stopped.
 */
export function receiptStanding(receipt: Receipt): ReceiptStanding {
  // A folder of repositories keeps its checks in its units, as the footer reads them too.
  const evidence = allEvidence(receipt);
  const { proofs, tests, models = [] } = evidence;
  const passed = [...proofs, ...tests, ...models].filter(({ verdict, evidence: run }) => verdict === "proved" && run.invalidated === undefined).length;
  const failed = [...proofs.map(({ evidence: run }) => evidenceEnd("proof", run)), ...tests.map(({ evidence: run }) => evidenceEnd("command", run)),
    ...models.map(modelEnd)].includes("failed");
  const units = receiptUnits(receipt).filter(verified).map(fromFolder);
  const paths = units.flatMap(changedPaths);
  // An inventory Git couldn't read is a gap: nothing shows every path it changed was covered.
  const unreadable = units.filter(({ changed }) => changed === "unreadable").length + (evidence.changed === "unreadable" ? 1 : 0);
  const gaps = receiptFindings(withoutUnproved(receipt)).filter(({ standing }) => standing === "gap").length + unreadable;
  // A change of comments alone changed lines, whatever paths the receipt names.
  return runStanding(evidence.changed === "unreadable" || paths.length > 0 || evidence.commentsOnly === true, receipt.stopped !== undefined,
    receiptDecisions(receipt), failed, passed, gaps, paths.map(({ proved }) => proved), paths.map(({ tested }) => tested),
    paths.map(({ exercised }) => exercised));
}

/** One row of the summary that names a method (#591): what it ran on and how each run ended, never more. */
export interface SummaryMethod { readonly glyph: string; readonly method: string; readonly text: string }

/** Findings of one reason as one row of the summary, every path they name kept in `items`. */
export interface SummaryGroup {
  readonly glyph: string;
  readonly title: string;
  readonly note: string;
  readonly items: readonly string[];
  /** A model's agreement, which only the expanded card shows. */
  readonly quiet?: true;
}

/**
 * The receipt's summary (#591), from its `details`: the counts, each method's
 * runs, then what needs review (`flags`, failed checks first among them),
 * the verification limits, and apart from both the models' opinions and the
 * request's context, which are neither evidence nor counted.
 */
export interface ReceiptSummary {
  readonly counts: string;
  readonly tone: ReturnType<typeof verdictTone>;
  readonly methods: readonly SummaryMethod[];
  /** What holds that no method row says, such as a change of comments only. */
  readonly notes: readonly SummaryGroup[];
  readonly flags: readonly SummaryGroup[];
  readonly limits: readonly SummaryGroup[];
  readonly opinions: readonly SummaryGroup[];
  readonly context: string;
}

export const ACCEPTANCE = "Check evidence, not your acceptance.";
export const OPINIONS = "Model opinions · not evidence, not counted";
export const DETAILS = "Details · paths, output, assumptions, model opinions";

/** Within each group of the summary, what most changes whether the evidence can be trusted comes first. */
const ORDER: readonly Check[] = ["proof", "tests", "model", "weakening", "contract", "exercise", "request", "coverage"];

/** How a run of a method ended, for its row's glyph. */
type Ran = "holds" | "partly" | "failed" | "none";

/** Each way a method's row sums up its runs (`methodStanding`, proved), as its glyph. */
const standingGlyphs: Readonly<Record<ReturnType<typeof methodStanding>, string>> = { holds: "✓", partly: "◐", fails: "✗", none: "○" };

/** A method's row: ✓ only when every run of it holds outright, ◐ when some do, ✗ when one failed and none holds. */
function methodRow(method: string, runs: readonly { readonly ran: Ran; readonly text: string }[]): SummaryMethod {
  if (runs.length === 0) return { glyph: "○", method, text: "none recorded" };
  const count = (ran: Ran): number => runs.filter((run) => run.ran === ran).length;
  return { glyph: standingGlyphs[methodStanding(count("holds"), count("partly"), count("failed"), runs.length)], method,
    text: runs.map(({ text }) => text).join("; ") };
}

/** How a proof, command or model that did not hold ended (`checkEnd`), in a word or two: only a failure is ✗. */
function notHeld(end: ReturnType<typeof checkEnd>, evidence: Evidence): { readonly ran: Ran; readonly words: string } {
  if (evidence.invalidated === "content_changed") return { ran: "none", words: "stale" };
  if (end === "failed") return { ran: "failed", words: "fails" };
  return { ran: "none", words: evidence.outcome === "vacuous" ? "verified nothing" : "did not run" };
}

/** A count of `of` in which `held` hold, said as all of them or as how many of them. */
const outOf = (held: number, of: number, one: string, many: string): string =>
  held === of ? plural(of, one, many) : `${held} of ${plural(of, one, many)}`;

function methodRows(evidence: Pick<UnitEvidence, "proofs" | "tests" | "models" | "exercises" | "contracts" | "weakened">): SummaryMethod[] {
  const proofs = evidence.proofs.map(({ path, verdict, evidence: run }) => {
    const assumed = addedAssumptions(run.files, evidence.weakened);
    const ended = verdict === "proved" ? { ran: assumed === 0 ? "holds" as const : "partly" as const,
      words: assumed === 0 ? "" : trusting(assumed) } : notHeld(evidenceEnd("proof", run), run);
    return { ran: ended.ran, text: [path, ended.words, clock(run.durationMs)].filter((part) => part !== "").join(" · ") };
  });
  const tests = evidence.tests.map(({ command, verdict, evidence: run }) => {
    const ended = verdict === "proved" ? { ran: "holds" as const, words: "" } : notHeld(evidenceEnd("command", run), run);
    return { ran: ended.ran, text: [command, ended.words, clock(run.durationMs)].filter((part) => part !== "").join(" · ") };
  });
  // A passing model is model-checked, about the model: never proved, and its row says whether anything links it to the code.
  // Model-checked holds outright only when every planted fault ran, the request did not write the model with its code,
  // and nothing says it may be stale; otherwise its limits say why it holds less (`modelFindings`).
  const outright = (model: ModelResult): boolean => !model.writtenWithCode && stalenessFindings(model).length === 0 &&
    model.faults.every(({ verdict }) => verdict !== "unrun");
  const models = (evidence.models ?? []).map((model) => {
    const { path, verdict, link, writtenWithCode, evidence: run } = model;
    const ended = verdict === "proved" ? { ran: outright(model) ? "holds" as const : "partly" as const,
      words: `model-checked, ${linkWords[link]}${writtenWithCode ? ", written with the code" : ""}` } : notHeld(modelEnd(model), run);
    return { ran: ended.ran, text: [path, ended.ran === "none" ? "not checked" : ended.words, clock(run.durationMs)].join(" · ") };
  });
  const noticing = evidence.exercises.filter(({ sensitivity }) => sensitivity === "fails_then_passes").length;
  const strong = evidence.contracts.filter((contract) => contractFinding(contract).standing === "holds").length;
  const partly = (held: number, of: number): string => standingGlyphs[methodStanding(held, 0, 0, of)];
  return [methodRow("Tested", tests), methodRow("Proved", proofs), methodRow("Models", models),
    ...noticing === 0 ? [] : [{ glyph: partly(noticing, evidence.exercises.length), method: "Exercised",
      text: `${outOf(noticing, evidence.exercises.length, "test file", "test files")} failed on the base and passed with the change` }],
    ...strong === 0 ? [] : [{ glyph: partly(strong, evidence.contracts.length), method: "Contracts",
      text: `${outOf(strong, evidence.contracts.length, "contract", "contracts")}: every decided change broke its proof` }]];
}

function findingGlyph({ standing, failed, muted }: Finding): string {
  if (muted === true) return "·";
  if (standing === "opinion") return "◇";
  if (standing === "decide") return failed === true ? "✗" : "!";
  return standing === "gap" ? "○" : "✓";
}

/** Findings of the same reason as one group each, in the order of `ORDER`, then as found. */
function grouped(findings: readonly Finding[]): SummaryGroup[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of [...findings].sort((a, b) => ORDER.indexOf(a.check) - ORDER.indexOf(b.check))) {
    const key = finding.group === undefined ? `${finding.label}\n${finding.detail}` : `${finding.group.title}\n${finding.group.note}`;
    groups.set(key, [...groups.get(key) ?? [], finding]);
  }
  return [...groups.values()].map((members) => {
    const [first] = members as [Finding, ...Finding[]];
    const { group } = first;
    const n = members.length;
    const named = (title: string): string => n > 1 ? `${title} · ${n}` : first.subject === "" ? title : `${title} · ${first.subject}`;
    const title = group === undefined ? named(first.label)
      : group.noun !== undefined ? group.title.replace("%", plural(n, ...group.noun)) : group.item === undefined ? group.title : named(group.title);
    const items = group === undefined ? members.map(({ subject }) => subject).filter((subject) => subject !== "")
      : members.flatMap((member) => member.group?.item === undefined ? [] : [member.group.item]);
    return { glyph: findingGlyph(first), title, note: group?.note ?? first.detail, items,
      ...first.standing === "opinion" && first.label === "Model: matches" ? { quiet: true as const } : {} };
  });
}

const counted = (n: number, one: string, many: string, none: string): string => n === 0 ? none : plural(n, one, many);

/** The summary's color (`receiptTone`): green says verified, and only a verified receipt is (#668), so one that verified nothing is amber. */
function summaryTone(receipt: Receipt, findings: readonly Finding[]): ReturnType<typeof verdictTone> {
  const tone = receiptTone(findings);
  return tone === "success" && receiptStanding(receipt) !== "verified" ? "warning" : tone;
}

/** The receipt's summary (`ReceiptSummary`). */
export function receiptSummary(receipt: Receipt): ReceiptSummary {
  const findings = receiptFindings(receipt);
  const of = (standing: Standing): Finding[] => findings.filter((finding) => finding.standing === standing);
  const failed = of("decide").filter((finding) => finding.failed === true).length;
  const flags = of("decide").length - failed;
  const inherited = allEvidence(receipt).inherited.length;
  return {
    counts: [...failed === 0 ? [] : [plural(failed, "failed check", "failed checks")],
      counted(flags, "review flag", "review flags", "no review flags"),
      counted(of("gap").length, "verification limit", "verification limits", "no verification limits")].join(" · ")
      .replace(/^n/u, "N"),
    tone: summaryTone(receipt, findings),
    methods: receipt.stopped === undefined ? methodRows(allEvidence(receipt)) : methodRows(noEvidence),
    notes: grouped(of("holds").filter(({ check }) => check === "coverage")),
    flags: grouped(of("decide")), limits: grouped(of("gap")), opinions: grouped(of("opinion")),
    context: [...(receipt.clarifications?.length ?? 0) === 0 ? [] : [plural(receipt.clarifications?.length ?? 0, "answer", "answers")],
      ...(receipt.children?.length ?? 0) === 0 ? [] : [plural(receipt.children?.length ?? 0, "subagent", "subagents")],
      ...(receipt.floorRefusals?.length ?? 0) === 0 ? [] : [`${plural(receipt.floorRefusals?.length ?? 0, "call", "calls")} the floor refused`],
      ...inherited === 0 ? [] : [`${plural(inherited, "file", "files")} already uncommitted, not this request's`]].join(" · "),
  };
}

/** A method's rows with their names in one column, as wide as the longest name and three more. */
export function methodWidth(methods: readonly SummaryMethod[]): number {
  return Math.max(...methods.map(({ method }) => method.length)) + 3;
}

/** Every fact the receipt records, one per line, as its details show them: each method's runs, each path, each reason. */
export function receiptDetailLines(receipt: Receipt): string[] {
  // Each unit's base: a commit, or Tesota's snapshot of a folder in no repository, which no one else can fetch.
  const based = ({ snapshot, base }: UnitEvidence, first: string): string =>
    `${snapshot === true ? "Tesota's snapshot " : ""}${base?.slice(0, 12) ?? first}`;
  const from = receipt.units === undefined ? based(receipt, "the first commit")
    : receipt.units.filter(verified).map((unit) => `${plainName(unit.folder)} ${based(unit, "its first commit")}`).join(", ");
  return [...receiptLines(receipt), ...requestJudgmentLines(receipt), `From ${from} · Tesota ${receipt.engine}${receipt.model === undefined ? "" : ` · ${receipt.model}`}`];
}

/** The judged request IDs, apart from check evidence and acceptance, including every capacity omission. */
function requestJudgmentLines(receipt: Pick<Receipt, "requestJudgments">): string[] {
  const ids = (runs: readonly number[]): string => runs.length < 2 ? runs.join("")
    : `${runs.slice(0, -1).join(", ")} and ${runs.at(-1)}`;
  const requests = (runs: readonly number[]): string => `${runs.length === 1 ? "request" : "requests"} ${ids(runs)}`;
  return (receipt.requestJudgments ?? []).flatMap(({ method, folder, requests: given, omitted }) => {
    const judge = method === "claimcheck" ? "ClaimCheck" : "Open cases";
    const unit = folder === "" ? "" : ` · ${plainName(folder)}`;
    return [`${judge} context: ${given.length === 0 ? "no requests supplied" : requests(given.map(({ run }) => run))}${unit}`,
      ...omitted.length === 0 ? [] : [`${judge} left out ${requests(omitted)}: context capacity${unit}`]];
  });
}

/**
 * The receipt as the operator reads it in plain text (#591): the summary,
 * then every fact under Details, then the request's context. Built from
 * `details`, apart from the Markdown, so no Markdown escape is in it.
 */
export function renderReceipt(receipt: Receipt): string {
  const summary = receiptSummary(receipt);
  const width = methodWidth(summary.methods);
  const groups = (list: readonly SummaryGroup[]): string[] =>
    list.flatMap(({ glyph, title, note }) => [`${glyph} ${title}`, ...note === "" ? [] : [`  ${note}`]]);
  const found = groups([...summary.notes, ...summary.flags, ...summary.limits]);
  return ["Tesota receipt", summary.counts, ACCEPTANCE, "",
    ...summary.methods.map(({ glyph, method, text }) => `${glyph} ${method.padEnd(width)}${text}`),
    ...found.length === 0 ? [] : ["", ...found],
    ...summary.opinions.length === 0 ? [] : ["", OPINIONS, ...groups(summary.opinions)],
    "", "Details", ...receiptDetailLines(receipt), ...receiptClarificationLines(receipt), ...receiptChildLines(receipt),
    ...receiptRefusalLines(receipt)].join("\n");
}

/** Each subagent the run started (#525), in one line; their ends are neither this receipt's evidence nor acceptance. */
function childLines(receipt: Pick<Receipt, "children">): string[] {
  return (receipt.children ?? []).map((child) =>
    `${child.description}: ${child.outcome}${child.verification === undefined ? "" : `, ${child.verification}`}`
    + `${!child.writes ? ", read only" : child.branch === undefined ? ", left no change" : `, on branch ${child.branch}`}`
    + `${child.floorRefusals === undefined ? "" : `, ${plural(child.floorRefusals, "call", "calls")} the floor refused`}`
    + `${child.unguarded === true ? ", with no guard on its branch" : ""}`
    + `${child.model === undefined ? "" : ` · ${child.model}`}`);
}

/** Each call Tesota's floor refused (#622), by tool and why, without what it named, which may be a secret's path. */
function refusalLines(receipt: Pick<Receipt, "floorRefusals">): string[] {
  return (receipt.floorRefusals ?? []).map(({ tool, reason }) => `${tool}: ${reason.replace(/^Tesota never allows this: /u, "")}`);
}

const refusalsHeading = "Refused by Tesota's floor (these calls didn't run; that says nothing of what ran instead)";

/** The floor's refusals as the receipt lists them, apart from its findings and its verdict. */
export function receiptRefusalLines(receipt: Pick<Receipt, "floorRefusals">): string[] {
  const lines = refusalLines(receipt);
  return lines.length === 0 ? [] : ["", refusalsHeading, ...lines.map((line) => `- ${line}`)];
}

const childrenHeading = "Subagents (each one's receipt covers its own branch, not this change)";

/** The subagents as the receipt lists them, apart from its findings. */
export function receiptChildLines(receipt: Pick<Receipt, "children">): string[] {
  const lines = childLines(receipt);
  return lines.length === 0 ? [] : ["", childrenHeading, ...lines.map((line) => `- ${line}`)];
}

/** Request context is separate from findings, so it cannot affect evidence counts or verdicts. */
export function receiptClarificationLines(receipt: Pick<Receipt, "clarifications">): string[] {
  return (receipt.clarifications ?? []).flatMap((clarification) => ["",
    "Request clarification (operator input, not evidence or acceptance)", ...clarificationText(clarification).split("\n")]);
}

const markdownText = (text: string): string => text.replace(/[\\`*_{}[\]()#+!|<>~-]/gu, "\\$&");

/**
 * The same receipt as Markdown for chat hosts, built from `details` as the
 * plain text is (#591): the summary as lists, its words escaped so none
 * renders, and the details fenced, so their paths and output are shown as
 * written. The TUI reads the structured details.
 */
export function renderReceiptMessage(receipt: Receipt): string {
  const summary = receiptSummary(receipt);
  const inline = (text: string): string => markdownText(text).replace(/\r?\n/gu, " ");
  const groups = (list: readonly SummaryGroup[]): string => list.map(({ glyph, title, note }) =>
    `- ${glyph} ${inline(title)}${note === "" ? "" : ` — ${inline(note)}`}`).join("\n");
  const found = [...summary.notes, ...summary.flags, ...summary.limits];
  const details = receiptDetailLines(receipt).join("\n");
  const fence = "`".repeat(Math.max(3, ...[...details.matchAll(/`+/gu)].map(([run]) => run.length + 1)));
  const clarifications = receiptClarificationLines(receipt);
  const children = childLines(receipt);
  const refusals = refusalLines(receipt);
  return ["## Tesota receipt", `**${inline(summary.counts)}**  \n${ACCEPTANCE}`,
    summary.methods.map(({ glyph, method, text }) => `- ${glyph} **${method}** — ${inline(text)}`).join("\n"),
    ...found.length === 0 ? [] : [groups(found)],
    ...summary.opinions.length === 0 ? [] : [`**${OPINIONS}**\n\n${groups(summary.opinions)}`],
    `**Details**\n\n${fence}text\n${details}\n${fence}`,
    ...clarifications.length === 0 ? [] : [clarifications.map((line) => `> ${markdownText(line)}`).join("\n")],
    ...children.length === 0 ? [] : [[markdownText(childrenHeading), ...children.map((line) => `- ${markdownText(line)}`)].join("\n")],
    ...refusals.length === 0 ? [] : [[markdownText(refusalsHeading), ...refusals.map((line) => `- ${markdownText(line)}`)].join("\n")],
  ].join("\n\n");
}

/** A stopped run's inventory (#599): each path it left changed, or why it could not be read, and what its captures left out. */
function leftLines(receipt: Receipt): string[] {
  return (receipt.units ?? [{ ...receipt, folder: "" }]).flatMap((unit) => [
    ...typeof unit.changed === "string"
      ? [`  not read      what ${unit.folder === "" ? "the run" : plainName(unit.folder)} left changed: ${unit.reason ?? "Git could not tell"}`]
      : unit.changed.map(({ path, blob }) => `  left changed  ${inUnit(unit.folder, path)}${blob === null ? " (deleted)" : ""}`),
    ...unit.endState?.status === "unknown" && typeof unit.changed !== "string"
      ? [`  not captured  the run's end: ${unit.endState.reason}; listed is every path that differs from the base`] : [],
    ...unit.unmeasured.map(({ path, reason }) => `  not measured  ${inUnit(unit.folder, path)}: ${reason}`),
    ...(unit.tooLarge ?? []).map((path) => `  not measured  ${inUnit(unit.folder, path)}: Tesota's snapshot left it out for its size`)]);
}

/**
 * The receipt recovery records for a run whose process ended before it
 * settled (#599): nothing verified it, and since no inventory of what it
 * left was saved, what changed is unknown; the files on disk when the
 * session opens again need not be what the run left.
 */
export function interruptedReceipt(run: Pick<Receipt, "repository" | "base" | "startedAt" | "settledAt" | "engine" |
  "clarifications" | "children" | "floorRefusals">): Receipt {
  return { version: 2, ...run, ...noEvidence, changed: "unreadable", lines: "unreadable",
    stopped: "the session ended before Tesota verified this run, so no check ran; change attribution is unknown, "
      + "and the files on disk now may not be what the run left. A new request verifies the current content",
    reason: "no inventory of what the run left was saved before its process ended" };
}

/** Shared evidence wording for terminal text and chat Markdown. */
function receiptLines(receipt: Receipt): string[] {
  if (receipt.stopped !== undefined) return [`  not verified  this request's changes: ${receipt.stopped}`, ...leftLines(receipt)];
  return [...receipt.unresolvedQuestion === undefined ? [] : [`  incomplete    ${receipt.unresolvedQuestion}`],
  ...receipt.units === undefined ? unitLines(receipt) : receipt.units.flatMap((unit) => verified(unit)
    ? unitLines(fromFolder(unit)) : [`  not verified  ${plainName(unit.folder)}: ${plainReason(unit)}`]),
  // One row for the whole change, every repository's lines together, last: it sums up the diff, not the evidence.
  ...linesRow(allEvidence(receipt).lines),
  ...openCaseLines(receipt.openCases)];
}

/** One unit's lines of the receipt, from the folder Pi runs in. */
function unitLines(receipt: UnitEvidence): string[] {
  if (!verified(receipt)) {
    return [`  not verified  this request's changes: ${receipt.reason ?? "the project has no Git repository, so Tesota cannot tell which files changed"}`];
  }
  const tested = receipt.tests.length > 0 && receipt.tests.every(({ verdict }) => verdict === "proved");
  const listed = [
    ...fingerprintFindings(receipt).filter(({ label }) => label !== "Attribution unresolved").map(({ label, subject, detail }) => `  not measured  ${label}: ${subject}${subject === "" ? "" : ": "}${detail}`),
    ...receipt.inherited.length === 0 ? [] : [`  inherited     ${receipt.inherited.length} ${receipt.inherited.length === 1 ? "file" : "files"} already uncommitted, not this request's`,
      ...receipt.inherited.map((path) => `                ${path}`),
      "                The tests ran with them; an exercise test relying on them may be misjudged against the base."],
    ...receipt.proofs.flatMap(({ path, verdict, evidence }) =>
      [line(path, verdict, evidence, addedAssumptions(evidence.files, receipt.weakened)),
        ...verdict === "proved" && evidence.invalidated === undefined ? [`                ${proofScope}`] : [],
        `                content sha256 ${evidence.contentHash}`]),
    ...receipt.contracts.flatMap(mutationLines),
    ...claimcheckLines(receipt.claimcheck, receipt.contracts),
    ...receipt.tests.map(testLine),
    ...(receipt.models ?? []).flatMap(modelLines),
    ...(receipt.unheaded ?? []).map((path) => `  not checked   ${path}: it declares no tesota-model header, so no model check ran`),
    ...receipt.exercises.map((exercise) => `  ${sensitivityText[exercise.sensitivity]} ${exercise.path}: ${exerciseDetail(exercise, resolved(receipt))}`),
    ...receipt.weakened === "too_large"
      ? ["  not checked   weakened evidence: the change is too large to check for weakening"]
      : receipt.weakened === "unreadable"
        ? ["  not checked   weakened evidence: Git could not show the change"] : receipt.weakened.flatMap((change) => weakening(change)),
    ...typeof receipt.weakened === "string" && receipt.proofs.length > 0
      ? ["  not checked   which changed lines the proofs cover, for the same reason"] : [],
    ...receipt.uncovered.filter(({ lines }) => lines.length > 0).map(({ path, lines }) => {
      const one = lines.length === 1 && lines[0]?.[0] === lines[0]?.[1];
      const where = `${path} ${one ? "line" : "lines"} ${lines.map(([start, end]) => start === end ? `${start}` : `${start}-${end}`).join(", ")}`;
      return (tested ? `  not proved    ${where}: outside the contracts that proved; the project's commands pass with them`
        : `  not verified  ${where}: outside the contracts that proved, and no verifier covers them`);
    }),
    ...receipt.unverified.map((path) => (tested
      ? `  not proved    ${path}: no proof covers it; the project's commands pass with it`
      : `  not verified  ${path}: no verifier covers it`)),
    ...(receipt.tooLarge ?? []).map((path) => `  not verified  ${path}: too large for Tesota's snapshot, which left it out`),
  ];
  // A change of comments alone leaves nothing to list; the receipt says so rather than ending empty.
  const nothing = listed.length === 0 && receipt.commentsOnly === true
    ? ["  no code       nothing to verify: the changes are comments or blank lines only"] : [];
  return [...listed, ...nothing];
}
