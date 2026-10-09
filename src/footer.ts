import { homedir } from "node:os";
import { sep } from "node:path";
import type { ContextUsage, ReadonlyFooterDataProvider, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GateProgress, GateStatus, Tally } from "./gate.js";
import type { Receipt } from "./receipt.js";
import { type EvidenceLevel, footerLayout } from "./verification/footer-rule.js";

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
  proving: part("◐ proving…", "◐ proving…", "◐", "accent"),
  testing: part("◐ testing…", "◐ testing…", "◐", "accent"),
  measuring: part("◐ measuring contracts…", "◐ measuring…", "◐", "accent"),
  sent_back: part("↺ sent back", "↺ sent back", "↺", "warning"),
} as const;

function tallyParts({ proved, notProved, tests, weak }: Tally): EvidencePart[] {
  return [
    ...proved > 0 ? [part(`${proved} proved`, `${proved} proved`, `✓${proved}`, "success")] : [],
    ...notProved > 0 ? [part(`${notProved} not proved`, `${notProved} unproved`, `✗${notProved}`, "error")] : [],
    ...tests === "pass" ? [part("tests pass", "tests ✓", "tests ✓", "success")] : [],
    ...tests === "fail" ? [part("tests fail", "tests ✗", "tests ✗", "error")] : [],
    ...weak !== undefined && weak > 0 ? [part(plural(weak, "weak contract", "weak contracts"), `${weak} weak`, `weak ${weak}`, "warning")] : [],
  ];
}

function lineCount(uncovered: Receipt["uncovered"]): number {
  return uncovered.reduce((sum, { lines }) => sum + lines.reduce((n, [start, end]) => n + end - start + 1, 0), 0);
}

/** The receipt in a row: what proved and passed, then what is weak, unproved or may weaken the evidence. */
function receiptParts(receipt: Receipt): EvidencePart[] {
  if (!receipt.repository) {
    return [part("! receipt", "! receipt", "!", "warning"), part("not verified, no Git repository", "no Git", "no Git", "warning")];
  }
  const proved = receipt.proofs.filter(({ verdict }) => verdict === "proved").length;
  const passed = receipt.tests.every(({ verdict }) => verdict === "proved");
  const weak = receipt.contracts.filter(({ mutation }) => mutation.survived.length > 0).length;
  const lines = lineCount(receipt.uncovered);
  const files = receipt.unverified.length;
  const weakening = receipt.weakened.length;
  // Commands that pass leave the rest tested though not proved, as the receipt words it.
  const unproved = passed && receipt.tests.length > 0 ? "not proved" : "not verified";
  const clean = proved === receipt.proofs.length && passed && weak === 0 && Array.isArray(receipt.weakened) && weakening === 0;
  return [
    clean ? part("✓ receipt", "✓ receipt", "✓", "success") : part("! receipt", "! receipt", "!", "warning"),
    ...tallyParts({ proved, notProved: receipt.proofs.length - proved,
      ...receipt.tests.length === 0 ? {} : { tests: passed ? "pass" : "fail" }, weak }),
    // Narrower rows keep what needs the operator, so they leave out contracts that held.
    ...receipt.contracts.length > 0 && weak === 0 ? [part("contracts strong", "", "", "success")] : [],
    ...lines > 0 ? [part(`${plural(lines, "line", "lines")} ${unproved}`, `${plural(lines, "line", "lines")} unproved`, `⚠${lines}`,
      "warning")] : [],
    ...files > 0 ? [part(`${plural(files, "file", "files")} ${unproved}`, `${plural(files, "file", "files")} unproved`, `⚠${files}f`,
      "warning")] : [],
    ...typeof receipt.weakened === "string" ? [part("weakening not checked", "unchecked", "unchecked", "warning")]
      : weakening > 0 ? [part(`${weakening} may weaken the evidence`, `${weakening} may weaken`, `weakens ${weakening}`, "warning")] : [],
  ];
}

/** What the footer's first row says for the gate's status. */
export function evidenceParts(status: GateStatus): EvidencePart[] {
  if (status.step === "ready") {
    const words = readinessWords[status.readiness];
    return [part("● ready", "● ready", "●", status.readiness === "nothing" ? "warning" : "success"), words];
  }
  if (status.step === "settled") return receiptParts(status.receipt);
  return [workingHeads[status.step], ...tallyParts(status.tally)];
}

/** The parts at one level, joined as the row shows them, without color. */
export function evidenceText(parts: readonly EvidencePart[], level: EvidenceLevel): string {
  return parts.filter((item) => item[level] !== "").map((item) => item[level]).join(SEPARATOR);
}

function paint(theme: Theme, parts: readonly EvidencePart[], level: EvidenceLevel): string {
  return parts.filter((item) => item[level] !== "").map((item) => theme.fg(item.color, item[level])).join(theme.fg("dim", SEPARATOR));
}

/** The folder as Pi's footer shows it: under the home folder, from `~`. */
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
 * Pi's footer in a Tesota session, under a blank row: the gate's evidence
 * with the context window's use at the right, then the folder and branch
 * with the model at the right. Narrowing drops the model, then shortens the
 * evidence, then drops the context % (`footerLayout`). Other extensions'
 * statuses follow on a third row, as in Pi's own footer.
 */
export class EvidenceFooter implements Component {
  readonly #theme: Theme;
  readonly #data: ReadonlyFooterDataProvider;
  readonly #progress: GateProgress;
  readonly #session: FooterSession;
  readonly #unsubscribe: () => void;
  readonly #unwatchBranch: () => void;

  constructor(theme: Theme, data: ReadonlyFooterDataProvider, progress: GateProgress, session: FooterSession,
    requestRender: () => void) {
    this.#theme = theme;
    this.#data = data;
    this.#progress = progress;
    this.#session = session;
    this.#unsubscribe = progress.subscribe(requestRender);
    this.#unwatchBranch = data.onBranchChange(requestRender);
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const parts = evidenceParts(this.#progress.status);
    const context = contextText(this.#theme, this.#session.context());
    const branch = this.#data.getGitBranch();
    const place = homeRelative(this.#session.cwd) + (branch === null ? "" : ` (${branch})`);
    const model = this.#session.model();
    const layout = footerLayout(inner, visibleWidth(evidenceText(parts, "full")), visibleWidth(evidenceText(parts, "short")),
      visibleWidth(evidenceText(parts, "glyphs")), visibleWidth(context.text), visibleWidth(place), visibleWidth(model));
    const statuses = [...this.#data.getExtensionStatuses().entries()].filter(([key]) => key !== "tesota")
      .sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text.replace(/[\r\n\t]/gu, " "));
    return ["",
      ` ${row(paint(this.#theme, parts, layout.level), layout.context ? context.styled : undefined, inner)}`,
      ` ${row(this.#theme.fg("dim", place), layout.model ? this.#theme.fg("dim", model) : undefined, inner)}`,
      ...statuses.length > 0 ? [` ${row(statuses.join(" "), undefined, inner)}`] : []];
  }

  invalidate(): void {}

  dispose(): void {
    this.#unsubscribe();
    this.#unwatchBranch();
  }
}
