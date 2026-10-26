import { homedir } from "node:os";
import { sep } from "node:path";
import { type ContextUsage, type FooterData, QUESTION_STATUS, type Theme, type ThemeColor } from "./contract.js";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GateProgress, GateStatus, Tally } from "./gate.js";
import { addedAssumptions, allEvidence, coveredCount, evidenceEnd, type Finding, modelEnd, type Receipt, receiptDecisions, receiptFindings, type ReceiptStanding, receiptStanding,
  receiptTone, type UnitEvidence, unverifiedWhy, verified } from "./receipt.js";
import { elapsedTime, type EvidenceLevel, footerLayout } from "./verification/footer-rule.js";

/** One piece of the evidence row, in its words, its shorter words and its glyph form; an empty form is left out. */
export interface EvidencePart {
  readonly full: string;
  readonly short: string;
  readonly glyphs: string;
  readonly color: ThemeColor;
}

const SEPARATOR = " · ";

function part(full: string, short: string, glyphs: string, color: ThemeColor): EvidencePart {
  return { full, short, glyphs, color };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const readinessWords = {
  proofs_and_tests: part("proofs and tests", "proofs, tests", "proofs+tests", "muted"),
  proofs_only: part("proofs only", "proofs", "proofs", "muted"),
  tests_only: part("tests only", "tests", "tests", "muted"),
  nothing: part("nothing to check with", "nothing", "nothing", "warning"),
} as const;

const workingHeads = {
  testing: part("◐ testing…", "◐ testing…", "◐ testing", "accent"),
  measuring: part("◐ measuring contracts…", "◐ measuring…", "◐ measuring", "accent"),
  checking: part("◐ checking models…", "◐ checking…", "◐ checking", "accent"),
  sent_back: part("↺ sent back", "↺ sent back", "↺", "warning"),
} as const;

/** The tally's parts; of the proofs that passed, `assumed` hold only given parts the change trusts without proof, and are told apart. */
function tallyParts({ proved, notProved, tests, weak }: Tally, assumed = 0): EvidencePart[] {
  const outright = proved - assumed;
  return [
    ...outright > 0 ? [part(`${outright} proved`, `${outright} proved`, `✓${outright}`, "success")] : [],
    ...assumed > 0 ? [part(`${assumed} proved on trust`, `${assumed} on trust`, `trust ${assumed}`, "warning")] : [],
    ...notProved > 0 ? [part(`${notProved} not proved`, `${notProved} unproved`, `✗${notProved}`, "error")] : [],
    ...tests === "pass" ? [part("tests pass", "tests ✓", "tests ✓", "success")] : [],
    ...tests === "fail" ? [part("tests fail", "tests ✗", "tests ✗", "error")] : [],
    ...weak !== undefined && weak > 0 ? [part(plural(weak, "weak contract", "weak contracts"), `${weak} weak`, `weak ${weak}`, "warning")] : [],
  ];
}

function lineCount(uncovered: Receipt["uncovered"]): number {
  return uncovered.reduce((sum, { lines }) => sum + lines.reduce((n, [start, end]) => n + end - start + 1, 0), 0);
}

/** The models' parts of the receipt's row: how many were model-checked, how many still fail, and how many may be stale. */
function modelParts(models: NonNullable<Receipt["models"]>): EvidencePart[] {
  const checked = models.filter(({ verdict }) => verdict === "proved").length;
  // Only an observed violation fails (`modelEnd`); a model that couldn't be checked is one of the gaps counted as not checked.
  const fails = models.filter((model) => modelEnd(model) === "failed").length;
  const stale = models.filter(({ staleness }) => staleness !== "current").length;
  return [...checked > 0 ? [part(plural(checked, "model checked", "models checked"), `${checked} modeled`, `model ${checked}`, "success")] : [],
    ...fails > 0 ? [part(plural(fails, "model fails", "models fail"), `${fails} model ✗`, `model ✗${fails}`, "error")] : [],
    ...stale > 0 ? [part(`${plural(stale, "model", "models")} possibly stale`, `${stale} stale`, `stale ${stale}`, "warning")] : []];
}

/** The receipt in a row: what proved and passed, then what is weak, unproved or may weaken the evidence. */
function receiptParts(settled: Receipt): EvidencePart[] {
  if (settled.stopped !== undefined) {
    return [part("! receipt", "! receipt", "!", "warning"),
      part("not verified, run ended before verification", "not verified", "not verified", "warning")];
  }
  // In a folder of repositories, the evidence of every unit verified together, and the folders nothing verified.
  const receipt = allEvidence(settled);
  const plain = (settled.units ?? []).filter((unit) => !verified(unit)).length;
  if (!verified(receipt)) {
    return [part("! receipt", "! receipt", "!", "warning"), part("not verified, no Git repository", "no Git", "no Git", "warning")];
  }
  const proofs = receipt.proofs.filter(({ verdict }) => verdict === "proved");
  const proved = proofs.length;
  // As the receipt in the conversation says, a proof that holds only given an assumption the change added is not proved outright.
  const assumed = proofs.filter(({ evidence }) => addedAssumptions(evidence.files, receipt.weakened) > 0).length;
  const passed = receipt.tests.every(({ verdict }) => verdict === "proved");
  const weak = receipt.contracts.filter(({ mutation }) => mutation.survived.length > 0).length;
  const lines = lineCount(receipt.uncovered);
  const files = receipt.unverified.length;
  const weakening = receipt.weakened.length;
  // Commands that pass leave the rest tested though not proved, as the receipt words it.
  const unproved = passed && receipt.tests.length > 0 ? "not proved" : "not verified";
  const unchanged = receipt.exercises.filter(({ sensitivity }) => sensitivity === "passes_on_base").length;
  const findings = receiptFindings(settled);
  const unchecked = uncheckedGaps(findings, receipt, coveredCount(settled));
  const listed = [
    // Only a proof that ran and doesn't hold is not proved (`evidenceEnd`); one that couldn't run, checked nothing or is stale is counted as not checked.
    ...tallyParts({ proved, notProved: receipt.proofs.filter(({ evidence }) => evidenceEnd("proof", evidence) === "failed").length,
      ...receipt.tests.length === 0 ? {} : { tests: passed ? "pass" : "fail" }, weak }, assumed),
    // Narrower rows keep what needs the operator, so they leave out contracts that held.
    // Strength needs a change the proof caught, as the receipt in the conversation says.
    ...receipt.contracts.length > 0 && receipt.contracts.every(({ mutation }) => mutation.survived.length === 0 && mutation.rejected > 0)
      ? [part("contracts strong", "", "", "success")] : [],
    ...modelParts(receipt.models ?? []),
    ...lines > 0 ? [part(`${plural(lines, "line", "lines")} ${unproved}`, `${plural(lines, "line", "lines")} unproved`, `○${lines}`,
      "warning")] : [],
    ...files > 0 ? [part(`${plural(files, "file", "files")} ${unproved}`, `${plural(files, "file", "files")} unproved`, `○${files}f`,
      "warning")] : [],
    ...unchecked > 0 ? [part(`${unchecked} not checked`, `${unchecked} unchecked`, `?${unchecked}`, "warning")] : [],
    // A test that passes without the change too: observed, not judged, so the words say only that.
    ...unchanged > 0 ? [part(`${plural(unchanged, "test passes", "tests pass")} without the change`,
      `${plural(unchanged, "test passes", "tests pass")} on base`, `base ${unchanged}`, "warning")] : [],
    ...typeof receipt.weakened === "string" ? [part("weakening not checked", "unchecked", "unchecked", "warning")]
      : weakening > 0 ? [part(`${weakening} may weaken the evidence`, `${weakening} may weaken`, `weakens ${weakening}`, "warning")] : [],
    ...plain > 0 ? [part(`${plural(plain, "folder", "folders")} not verified, no Git`, `${plain} no Git`, `no Git ${plain}`, "warning")] : [],
  ];
  const standing = receiptStanding(settled);
  return [receiptHead(settled, findings, standing), ...listed, ...listed.length > 0 ? [] : nothingListed(settled, standing)];
}

/** Why the row lists nothing else (#668): a change of comments alone, nothing verified, or nothing changed. */
function nothingListed(settled: Receipt, standing: ReceiptStanding): EvidencePart[] {
  if (allEvidence(settled).commentsOnly === true) return [part("nothing to verify, comments only", "nothing to verify", "no code", "muted")];
  if (standing === "unverified") return [part(`unverified, ${unverifiedWhy(settled)}`, "unverified", "unverified", "warning")];
  return standing === "unchanged" ? [part("nothing to verify, nothing changed", "nothing to verify", "nothing", "muted")] : [];
}

/**
 * The row's first word, with the receipt's count and color in the
 * conversation (`receiptTone`): `!` when something needs the operator, `✓`
 * only when the receipt is verified (`receiptStanding`), `○` otherwise, in
 * the muted color when nothing changed.
 */
function receiptHead(settled: Receipt, findings: readonly Finding[], standing: ReceiptStanding): EvidencePart {
  const tone = receiptTone(findings);
  if (receiptDecisions(settled) > 0) return part("! receipt", "! receipt", "!", tone);
  if (standing === "verified") return part("✓ receipt", "✓ receipt", "✓", "success");
  return part("○ receipt", "○ receipt", "○", standing === "unchanged" ? "muted" : "warning");
}

/**
 * The gaps the row's other parts do not name, such as a contract not
 * measured or a test not checked, so amber always says why: every gap but
 * the uncovered lines, unverified files and models possibly stale counted
 * on their own, and the coverage left unchecked because Git could not show
 * the change, named with its weakening. The `covered` unverified files are
 * no gap (`coveredCount`), so only the others are taken off.
 */
function uncheckedGaps(findings: readonly Finding[], receipt: UnitEvidence, covered: number): number {
  return findings.filter(({ standing }) => standing === "gap").length
    - receipt.uncovered.filter(({ lines }) => lines.length > 0).length - (receipt.unverified.length - covered)
    - (receipt.models ?? []).filter(({ staleness }) => staleness !== "current").length
    - (typeof receipt.weakened === "string" && receipt.proofs.length > 0 ? 1 : 0);
}

/** What the footer's row says for the gate's status; `asked` while the shell waits for the operator's answer to a question. */
export function evidenceParts(status: GateStatus, now: number = performance.now(), asked = false): EvidencePart[] {
  if (status.step === "ready") {
    const words = readinessWords[status.readiness];
    return [part("● ready", "● ready", "●", status.readiness === "nothing" ? "warning" : "success"), words];
  }
  // While the agent works nothing is ready or verified yet: the gate waits, with what it will check once the run settles;
  // while the run waits on the operator's answer, it says so.
  if (status.step === "waiting") {
    return [asked ? part("◌ waiting for you", "◌ for you", "◌ you", "accent") : part("◌ waiting for the agent", "◌ waiting", "◌", "muted"),
      readinessWords[status.readiness]];
  }
  if (status.step === "settled") return receiptParts(status.receipt);
  if (status.step === "sent_back") return [workingHeads.sent_back, ...tallyParts(status.tally)];
  const { minutes, seconds } = elapsedTime(Math.max(0, Math.floor(now - status.startedAt)));
  const elapsed = minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  // The status line beside the orb names the file or command running (#590); the footer keeps the step, its timer and the tally.
  const head = status.step === "proving" ? part("◐ proving", "◐ proving", "◐ proving", "accent") : workingHeads[status.step];
  return [part(`${head.full}${SEPARATOR}${elapsed}`, `${head.short}${SEPARATOR}${elapsed}`, head.glyphs, head.color),
    ...tallyParts(status.tally)];
}

/** The parts at one level, joined as the row shows them, without color. */
export function evidenceText(parts: readonly EvidencePart[], level: EvidenceLevel): string {
  return parts.filter((item) => item[level] !== "").map((item) => item[level]).join(SEPARATOR);
}

function paint(theme: Theme, parts: readonly EvidencePart[], level: EvidenceLevel): string {
  return parts.filter((item) => item[level] !== "").map((item) => theme.fg(item.color, item[level])).join(theme.fg("dim", SEPARATOR));
}

/** A folder as the footer and the welcome header show it: under the home folder, from `~`. */
export function homeRelative(cwd: string, home: string = homedir()): string {
  if (home === "" || !(cwd === home || cwd.startsWith(home + sep))) return cwd;
  return `~${cwd.slice(home.length)}`;
}

export interface FooterSession {
  readonly cwd: string;
  /** The session's model and its thinking level, as the footer shows them. */
  readonly model: () => string;
  readonly context: () => ContextUsage | undefined;
}

/** The context window's use: in the warning color past 70%, the error color past 90%, as in Pi's footer. */
function contextText(theme: Theme, usage: ContextUsage | undefined): { text: string; styled: string } {
  if (usage?.percent == null) return { text: "ctx ?", styled: theme.fg("muted", "ctx ?") };
  const text = `ctx ${Math.round(usage.percent)}%`;
  return { text, styled: theme.fg(usage.percent > 90 ? "error" : usage.percent > 70 ? "warning" : "muted", text) };
}

/** A row of `width` columns: `left`, and `right` against the right edge when it is given. */
function row(left: string, right: string | undefined, width: number): string {
  const fitted = truncateToWidth(left, width, "…");
  if (right === undefined) return fitted;
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted) - visibleWidth(right))) + right;
}

/**
 * Pi's footer in a Tesota session, one row under a blank one: the gate's
 * evidence, and at the right the folder and branch, the model, the context
 * window's use and the other extensions' statuses, the permission mode among
 * them. Narrowing drops the folder, then the model, then shortens the
 * evidence, then drops the context %; the statuses always show
 * (`footerLayout`).
 */
export class EvidenceFooter implements Component {
  readonly #theme: Theme;
  readonly #data: FooterData;
  readonly #progress: GateProgress;
  readonly #session: FooterSession;
  readonly #unsubscribe: () => void;
  readonly #unwatchBranch: () => void;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(theme: Theme, data: FooterData, progress: GateProgress, session: FooterSession,
    requestRender: () => void) {
    this.#theme = theme;
    this.#data = data;
    this.#progress = progress;
    this.#session = session;
    const update = (): void => {
      if ("startedAt" in progress.status) {
        this.#timer ??= setInterval(requestRender, 1000);
      } else {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
      requestRender();
    };
    this.#unsubscribe = progress.subscribe(update);
    this.#unwatchBranch = data.onBranchChange(requestRender);
    if ("startedAt" in progress.status) this.#timer = setInterval(requestRender, 1000);
  }

  render(width: number): string[] {
    const inner = Math.max(0, width - 2);
    const shown = this.#data.getExtensionStatuses();
    const parts = evidenceParts(this.#progress.status, performance.now(), shown.has(QUESTION_STATUS));
    const context = contextText(this.#theme, this.#session.context());
    const branch = this.#data.getGitBranch();
    const place = homeRelative(this.#session.cwd) + (branch === null ? "" : ` (${branch})`);
    const model = this.#session.model();
    // A waiting question is said by the evidence, so it is not listed again at the right.
    const statuses = [...shown.entries()].filter(([key]) => key !== "tesota" && key !== QUESTION_STATUS)
      .sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text.replace(/[\r\n\t]/gu, " ")).join(SEPARATOR);
    const layout = footerLayout(inner, visibleWidth(evidenceText(parts, "full")), visibleWidth(evidenceText(parts, "short")),
      visibleWidth(evidenceText(parts, "glyphs")), visibleWidth(context.text), visibleWidth(place), visibleWidth(model),
      visibleWidth(statuses));
    const right = [...layout.place ? [this.#theme.fg("dim", place)] : [], ...layout.model ? [this.#theme.fg("dim", model)] : [],
      ...layout.context ? [context.styled] : [], ...statuses === "" ? [] : [this.#theme.fg("text", statuses)]]
      .join(this.#theme.fg("dim", SEPARATOR));
    // Too narrow for even the glyphs beside the statuses, the row is cut at the edge rather than wrapped.
    return ["", truncateToWidth(` ${row(paint(this.#theme, parts, layout.level), right === "" ? undefined : right, inner)}`, width, "")];
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.#timer);
    this.#unsubscribe();
    this.#unwatchBranch();
  }
}
