import { type ExtensionAPI, keyText, type MessageRenderOptions, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, type Component, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SentBack } from "./gate.js";
import { allEvidence, commandFinding, contractFinding, type Finding, isNote, isReceipt, plainName, proofFinding, type Receipt,
  receiptFindings, type UnitEvidence, verified } from "./receipt.js";
import { decisions } from "./verification/verdict-rule.js";

/** `line` broken at spaces into rows of `width` columns, every row after the first indented by `indent` columns. */
export function hang(line: string, width: number, indent: number): string[] {
  const rows: string[] = [];
  let rest = line;
  let lead = "";
  while (visibleWidth(lead + rest) > width) {
    const room = Math.max(1, width - visibleWidth(lead));
    const head = sliceByColumn(rest, 0, room + 1);
    const space = head.lastIndexOf(" ");
    // A word longer than the row, such as a hash or a path, is cut at the row's end.
    const cut = space > 0 ? space : sliceByColumn(rest, 0, room).length;
    rows.push(lead + rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
    lead = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
  }
  rows.push(lead + rest);
  return rows;
}

/** Styled `text` wrapped to `width`, every row after the first starting at column `indent`. */
export function wrapUnder(text: string, width: number, indent: number): string[] {
  const [first = "", ...rest] = wrapTextWithAnsi(text, Math.max(1, width));
  if (rest.length === 0) return [first];
  return [first, ...wrapTextWithAnsi(rest.join(" "), Math.max(1, width - indent)).map((row) => " ".repeat(indent) + row)];
}

/** `row` cut to `width` with an ellipsis that resets only color and weight: Pi's full reset would also clear a card's background. */
function cut(row: string, width: number): string {
  return visibleWidth(row) <= width ? row : truncateToWidth(row, width, "…").replaceAll("\x1b[0m", "\x1b[39m\x1b[22m");
}

/** Rows already laid out, each cut to the width. */
export class Rows implements Component {
  readonly #draw: (width: number) => readonly string[];

  constructor(draw: (width: number) => readonly string[]) { this.#draw = draw; }

  render(width: number): string[] { return this.#draw(width).map((row) => cut(row, width)); }

  invalidate(): void {}
}

/** `left` and `right` on one row, `right` against the far edge; `left` is cut first. */
export function spread(left: string, right: string, width: number): string {
  const room = width - visibleWidth(right) - 1;
  if (room < 8) return left;
  const shown = cut(left, room);
  return shown + " ".repeat(Math.max(1, width - visibleWidth(shown) - visibleWidth(right))) + right;
}

export function bold(text: string): string {
  return `\x1b[1m${text}\x1b[22m`;
}

/** Pi's hint for Ctrl+O, in its words and with its name for the key, in the theme the renderer was given. */
export function expandHint(theme: Theme, what: string): string {
  return theme.fg("dim", keyText("app.tools.expand")) + theme.fg("muted", ` ${what}`);
}

/** The footer's glyphs, so the conversation and the footer say the same things the same way. */
function glyph(finding: Finding): string {
  if (finding.standing === "opinion") return "◇";
  if (finding.standing === "decide") return finding.failed === true ? "✗" : "!";
  return finding.standing === "gap" ? "○" : "✓";
}

function color(finding: Finding): ThemeColor {
  if (finding.standing === "opinion") return "accent";
  if (finding.standing === "decide") return finding.failed === true ? "error" : "warning";
  return finding.standing === "gap" ? "muted" : "success";
}

/** Within a section, what most changes whether the evidence can be trusted comes first. */
const ORDER: readonly Finding["check"][] = ["proof", "tests", "weakening", "contract", "exercise", "request", "coverage"];
const byCheck = (a: Finding, b: Finding): number => ORDER.indexOf(a.check) - ORDER.indexOf(b.check);

/** The fewest columns the text beside the labels keeps; with fewer, expanded rows wrap under the glyph instead. */
const TEXT_COLUMNS = 30;

/** One finding: its glyph, its label in a column `label` wide, then what it is about and why; its details under it when expanded. */
function findingRows(theme: Theme, finding: Finding, label: number, width: number, expanded: boolean): string[] {
  const tone = color(finding);
  const head = `${theme.fg(tone, glyph(finding))}  ${theme.fg(finding.standing === "gap" ? "muted" : tone, finding.label.padEnd(label))}` +
    theme.fg("text", finding.subject) +
    (finding.detail === "" ? "" : theme.fg("muted", `${finding.subject === "" ? "" : " — "}${finding.detail}`));
  if (!expanded) return [head];
  const column = width - label - 3 >= TEXT_COLUMNS ? label + 3 : 3;
  return [...wrapUnder(head, width, column),
    ...finding.more.flatMap((line) => wrapUnder(theme.fg("dim", line), width - column, 0).map((row) => " ".repeat(column) + row))];
}

function labelWidth(findings: readonly Finding[]): number {
  return Math.max(0, ...findings.map(({ label }) => label.length)) + 2;
}

function section(theme: Theme, title: string, findings: readonly Finding[], label: number, width: number, expanded: boolean): string[] {
  if (findings.length === 0) return [];
  return ["", theme.fg("dim", bold(title)), ...findings.flatMap((finding) => findingRows(theme, finding, label, width, expanded))];
}

function card(theme: Theme, options: MessageRenderOptions, draw: (width: number) => readonly string[]): Component {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Rows(draw));
  return box;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const isMatch = (finding: Finding): boolean => finding.standing === "opinion" && finding.label === "Model: matches";

/** What holds, in one row: each label once, with how many when more than one, and the model's agreement as a note. */
function holdsRow(theme: Theme, holds: readonly Finding[], matches: number): string {
  const counts = new Map<string, number>();
  for (const { label } of holds) counts.set(label, (counts.get(label) ?? 0) + 1);
  const words = [...counts].map(([label, count]) => count === 1 ? label : `${label} (${count})`);
  return `${theme.fg("success", "✓")}  ${theme.fg("muted", words.join(" · "))}` +
    (matches === 0 ? "" : `${theme.fg("dim", " · ")}${theme.fg("accent", `◇ model: ${matches === 1 ? "matches" : `${matches} match`} the request`)}`);
}

/**
 * The receipt as a card: the verdict first, then what needs the operator,
 * the model's notes, what is not proved, and in one row what holds. Only what
 * the checks established counts toward the verdict (`decisions`); a model's
 * opinion is a note beside it. A receipt with nothing to decide, no gap and
 * no note is two rows. Expanded, every finding shows its details and what
 * holds is listed.
 */
function receiptCard(theme: Theme, receipt: Receipt, options: MessageRenderOptions): Component {
  const findings = receiptFindings(receipt).sort(byCheck);
  const decide = findings.filter(({ standing }) => standing === "decide");
  const opinions = findings.filter(({ standing }) => standing === "opinion");
  const notes = opinions.filter(isNote);
  const matches = opinions.filter(isMatch).length;
  const gaps = findings.filter(({ standing }) => standing === "gap");
  const holds = findings.filter(({ standing }) => standing === "holds");
  const count = decisions(findings.map(({ standing }) => standing));
  const verdict = count === 0 ? theme.fg("success", bold("✓ Nothing needs you"))
    : theme.fg(decide.some(({ failed }) => failed === true) ? "error" : "warning", bold(`! ${plural(count, "thing needs", "things need")} you`));
  const noted = notes.length === 0 ? "" : `${theme.fg("dim", " · ")}${theme.fg("accent", `◇ ${plural(notes.length, "model note", "model notes")}`)}`;
  const label = labelWidth(findings);
  const { tests } = allEvidence(receipt);
  const unproved = tests.length > 0 && tests.every(({ verdict: v }) => v === "proved") ? "NOT PROVED" : "NOT VERIFIED";
  // Each unit's base: a commit, or Tesota's snapshot of a folder in no repository, which no one else can fetch.
  const based = ({ snapshot, base }: UnitEvidence, first: string): string =>
    `${snapshot === true ? "Tesota's snapshot " : ""}${base?.slice(0, 12) ?? first}`;
  const from = receipt.units === undefined ? based(receipt, "the first commit")
    : receipt.units.filter(verified).map((unit) => `${plainName(unit.folder)} ${based(unit, "its first commit")}`).join(", ");
  return card(theme, options, (width) => {
    const title = spread(verdict + noted, theme.fg("customMessageLabel", bold("Tesota receipt")), width);
    if (!options.expanded && decide.length === 0 && gaps.length === 0 && opinions.every(isMatch)) {
      return [title, spread(holdsRow(theme, holds, matches), expandHint(theme, "for details"), width)];
    }
    const shown = options.expanded ? opinions : opinions.filter((finding) => !isMatch(finding));
    return [title,
      ...section(theme, "NEEDS YOU", decide, label, width, options.expanded),
      ...section(theme, "MODEL'S OPINION, NOT A PROOF", shown, label, width, options.expanded),
      ...section(theme, unproved, gaps, label, width, options.expanded),
      ...options.expanded ? section(theme, "VERIFIED", holds, label, width, true)
        : holds.length + matches === 0 ? [] : ["", holdsRow(theme, holds, matches)],
      "", ...options.expanded ? wrapUnder(theme.fg("dim", `From ${from} · Pi ${receipt.pi}` +
        `${receipt.model === undefined ? "" : ` · ${receipt.model}`} · check evidence, not a reviewer's acceptance`), width, 0)
        : [expandHint(theme, "for details")]];
  });
}

/** What a send-back round asks the agent to fix, as findings; a weak contract names the changes to its code that still prove. */
function sentBackFindings(sent: SentBack): Finding[] {
  if (sent.round === "proofs") return sent.proofs.map(({ path, evidence }) => proofFinding({ path, verdict: "send_back", evidence }));
  if (sent.round === "tests") return sent.commands.map((run) => commandFinding({ ...run, verdict: "send_back" }));
  return sent.contracts.map((contract) => ({ ...contractFinding(contract),
    detail: contract.mutation.survived.map(({ line, before, after }) => `line ${line}: ${before} → ${after} still proves`).join("; ") }));
}

function headline(sent: SentBack): string {
  if (sent.round === "proofs") return sent.proofs.length === 1 ? "a proof fails" : `${sent.proofs.length} proofs fail`;
  if (sent.round === "tests") return "the tests fail";
  return sent.contracts.length === 1 ? "a contract is too weak" : `${sent.contracts.length} contracts are too weak`;
}

/**
 * What the gate sent back, as a card: what fails, one row each; expanded,
 * their details and the text the agent read, as it read it.
 */
function sentBackCard(theme: Theme, sent: SentBack, content: string, options: MessageRenderOptions): Component {
  const findings = sentBackFindings(sent);
  const label = labelWidth(findings);
  return card(theme, options, (width) => [
    spread(theme.fg("warning", bold(`↺ Sent back to the agent: ${headline(sent)}`)), theme.fg("customMessageLabel", bold("Tesota")), width),
    "", ...findings.flatMap((finding) => findingRows(theme, finding, label, width, options.expanded)),
    "", ...options.expanded
      ? [theme.fg("dim", bold("WHAT THE AGENT READ")), ...content.split("\n")
        .flatMap((line) => hang(line, width, line.length - line.trimStart().length + 2)).map((row) => theme.fg("muted", row))]
      : [expandHint(theme, "to see what the agent read")],
  ]);
}

function text(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text ?? ""] : []).join("\n");
}

/**
 * How Tesota's session messages look, drawn from their `details`: the
 * receipt and what the gate sends back, each as a card with its verdict
 * first. Ctrl+O, which Pi applies to every tool and message at once, expands
 * them. A message without details is left to Pi.
 */
export function registerMessages(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("tesota-receipt", (message, options, theme) =>
    isReceipt(message.details) ? receiptCard(theme, message.details, options) : undefined);
  pi.registerMessageRenderer<SentBack>("tesota-gate", (message, options, theme) =>
    message.details === undefined ? undefined : sentBackCard(theme, message.details, text(message.content), options));
}
