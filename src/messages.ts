import type { ExtensionAPI, MessageRenderer, Theme, ThemeColor } from "./contract.js";
import { host } from "./host.js";
import { Box, type Component, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { terminalText } from "./terminal-text.js";
import type { GraphCapture } from "./model-graph.js";
import type { SentBack } from "./gate.js";
import type { LedgerRow } from "./operations.js";
import { ACCEPTANCE, commandFinding, contractFinding, DETAILS, type Finding, isReceipt, methodWidth, modelFinding, OPINIONS, proofFinding,
  type Receipt, type ReceiptGraph, type ReceiptGraphMessage, receiptChildLines, receiptClarificationLines, receiptRefusalLines, receiptDetailLines, receiptSummary, type SummaryGroup } from "./receipt.js";

/** How the shell asks a message to be drawn: expanded or not, and how far in. */
type RenderOptions = Parameters<MessageRenderer>[1];

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
  return theme.fg("dim", host().keyText("app.tools.expand")) + theme.fg("muted", ` ${what}`);
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

/** Compact adjacency notation: all concrete edges when it fits; never a nested viewport. */
export function graphPreviewRows(capture: GraphCapture | undefined, width: number): string[] {
  if (capture === undefined) return [cut("Graph unavailable: no capture", width)];
  if (capture.status !== "captured") return [cut(terminalText(`Graph ${capture.status}: ${capture.reason}`), width)];
  if (capture.preview === undefined) return [cut("Graph preview unavailable; open captured files beside the session", width)];
  const preview = capture.preview;
  const diagram: string[] = [];
  let row = "| ";
  for (const [index, entry] of preview.entries.entries()) {
    const token = preview.kind === "trace" && index > 0 ? `-> ${entry}` : entry;
    const gap = row === "| " ? "" : preview.kind === "trace" ? " " : "  ";
    if (visibleWidth(row + gap + token) > width && row !== "| ") { diagram.push(row); row = "| "; }
    row += `${row === "| " ? "" : gap}${token}`;
  }
  if (row !== "| ") diagram.push(row.trimEnd());
  const stem = capture.manifest.replace(/\.manifest\.json$/u, "");
  const bound = preview.partial ? ">=" : "";
  return [...preview.partial ? hang("Partial exploration; counts are lower bounds", width, 0) : [],
    ...hang(`${bound}${preview.reached} reached · ${bound}${preview.violating} reported violating (not a safety verdict)`, width, 0),
    ...hang(`${preview.kind === "trace" ? "Counterexample path" : "Reached graph"} (states in .txt order; ! = reported violation)`, width, 0),
    ...diagram.length <= 6 && !preview.omitted && diagram.every((line) => visibleWidth(line) <= width) ? diagram
      : preview.kind === "trace" ? [...diagram.slice(0, 5).map((line) => cut(line, width)), ...hang("Path continues; open graph files", width, 0)]
        : hang("Diagram does not fit; open graph files", width, 0),
    ...hang(`Open graph: in a text editor, open the files beside the session with stem ${terminalText(stem)} and extension .dot, .mmd or .txt.`, width, 0)];
}

/** The fewest columns the text beside the labels keeps; with fewer, expanded rows wrap under the glyph instead. */
const TEXT_COLUMNS = 30;

/**
 * One finding: its glyph, its label in a column `label` wide, then what it
 * is about and why, wrapped under the text so the reason is never cut; its
 * details under it when expanded.
 */
function findingRows(theme: Theme, finding: Finding, label: number, width: number, expanded: boolean): string[] {
  const tone = color(finding);
  const head = `${theme.fg(tone, glyph(finding))}  ${theme.fg(finding.standing === "gap" ? "muted" : tone, finding.label.padEnd(label))}` +
    theme.fg("text", finding.subject) +
    (finding.detail === "" ? "" : theme.fg("muted", `${finding.subject === "" ? "" : " — "}${finding.detail}`));
  const column = width - label - 3 >= TEXT_COLUMNS ? label + 3 : 3;
  if (!expanded) return wrapUnder(head, width, column);
  return [...wrapUnder(head, width, column),
    ...finding.more.flatMap((line) => wrapUnder(theme.fg("dim", line), width - column, 0).map((row) => " ".repeat(column) + row))];
}

function labelWidth(findings: readonly Finding[]): number {
  return Math.max(0, ...findings.map(({ label }) => label.length)) + 2;
}

function card(theme: Theme, options: RenderOptions, draw: (width: number) => readonly string[]): Component {
  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Rows(draw));
  return box;
}

/** A summary row's glyph in the color of what it says: a pass green, a failure red, a flag or a partial result amber. */
function tinted(theme: Theme, glyph: string): string {
  const tone: ThemeColor = glyph === "✓" ? "success" : glyph === "✗" ? "error" : glyph === "!" || glyph === "◐" || glyph === "↺" ? "warning"
    : glyph === "◇" || glyph === "›" ? "accent" : glyph === "·" ? "dim" : "muted";
  return theme.fg(tone, glyph);
}

/** Groups of the summary: a glyph and title, the reason they share under it. */
function groupRows(theme: Theme, groups: readonly SummaryGroup[], width: number): string[] {
  return groups.flatMap(({ glyph, title, note }) => [...wrapUnder(`${tinted(theme, glyph)} ${theme.fg("text", terminalText(title))}`, width, 2),
    ...note === "" ? [] : wrapUnder(theme.fg("muted", `  ${terminalText(note)}`), width, 2)]);
}

/**
 * The receipt as the request's one block (#591), drawn from its details as
 * the plain text is: the counts and the acceptance line, each method, what
 * needs review and the limits grouped by reason, the models' opinions apart
 * and never counted, then the request's context and the details. Ctrl+O
 * expands the context and the details, where every path is.
 */
function receiptCard(theme: Theme, receipt: Receipt, options: RenderOptions, graphs: readonly ReceiptGraph[] = []): Component {
  const summary = receiptSummary(receipt);
  const method = methodWidth(summary.methods);
  const opinions = options.expanded ? summary.opinions : summary.opinions.filter(({ quiet }) => quiet !== true);
  const context = [...receiptClarificationLines(receipt), ...receiptChildLines(receipt), ...receiptRefusalLines(receipt)];
  const dim = (lines: readonly string[], width: number): string[] =>
    lines.flatMap((line) => hang(terminalText(line), width, line.length - line.trimStart().length + 2)).map((row) => theme.fg("dim", row));
  return card(theme, options, (width) => {
    const found = groupRows(theme, [...summary.notes, ...summary.flags, ...summary.limits], width);
    return [theme.fg("customMessageLabel", bold("Tesota receipt")),
      ...wrapUnder(theme.fg(summary.tone, bold(summary.counts)), width, 0), theme.fg("muted", ACCEPTANCE), "",
      ...summary.methods.flatMap(({ glyph, method: name, text }) =>
        wrapUnder(`${tinted(theme, glyph)} ${theme.fg("text", name.padEnd(method))}${theme.fg("muted", terminalText(text))}`, width, method + 2)),
      ...graphs.flatMap(({ subject, capture }) => ["", ...hang(terminalText(subject), width, 0),
        ...graphPreviewRows(capture, width).map((line) => theme.fg("muted", line))]),
      ...found.length === 0 ? [] : ["", ...found],
      ...opinions.length === 0 ? [] : ["", ...wrapUnder(theme.fg("dim", bold(OPINIONS)), width, 0), ...groupRows(theme, opinions, width)],
      "",
      ...options.expanded ? [theme.fg("dim", bold("▾ Details")), ...dim(receiptDetailLines(receipt), width)]
        : wrapUnder(theme.fg("dim", `▸ ${DETAILS}`), width, 2),
      ...summary.context === "" ? [] : options.expanded ? ["", theme.fg("dim", bold("▾ Context")), ...dim(context, width)]
        : wrapUnder(theme.fg("dim", `▸ Context · ${summary.context}`), width, 2)];
  });
}

/** What the live ledger reads: the gate's operations as rows, all of them or the latest (`GateOperations.ledger`). */
interface Ledger { ledger(now: number, all: boolean): readonly LedgerRow[] }

const isLedger = (value: unknown): value is Ledger =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, "ledger") === "function";

/**
 * The request's block while the gate verifies (#591): what runs, what ended
 * and how, each attempt that went back folded into a row; every check when
 * expanded. It reads the ledger each time it is drawn, so it stays live; the
 * receipt takes its place when the run settles.
 */
function ledgerCard(theme: Theme, ledger: Ledger, options: RenderOptions): Component {
  return card(theme, options, (width) => [
    spread(theme.fg("accent", bold("Verifying")), theme.fg("customMessageLabel", bold("Tesota receipt")), width),
    ...ledger.ledger(performance.now(), options.expanded).flatMap(({ glyph, text, depth }) =>
      wrapUnder(`${"  ".repeat(depth)}${tinted(theme, glyph)} ${theme.fg(glyph === "›" ? "text" : "muted", terminalText(text))}`, width, 2 * depth + 2)),
  ]);
}
/** What a send-back round asks the agent to fix, as findings; a weak contract names the changes to its code that still prove. */
function sentBackFindings(sent: SentBack): Finding[] {
  if (sent.round === "proofs") return sent.proofs.map(({ path, evidence }) => proofFinding({ path, verdict: "send_back", evidence }));
  if (sent.round === "tests") return sent.commands.map((run) => commandFinding({ ...run, verdict: "send_back" }));
  if (sent.round === "models") {
    return [...sent.models.map((model) => modelFinding({ ...model, verdict: "send_back" })),
      ...sent.unheaded.map((path): Finding => ({ standing: "decide", check: "model", label: "Model without a header", subject: path,
        detail: "Tesota checks a model once it declares a tesota-model header", more: [] }))];
  }
  return sent.contracts.map((contract) => ({ ...contractFinding(contract),
    detail: contract.mutation.survived.map(({ line, before, after }) => `line ${line}: ${before} → ${after} still proves`).join("; ") }));
}

function headline(sent: SentBack): string {
  if (sent.round === "proofs") return sent.proofs.length === 1 ? "a proof fails" : `${sent.proofs.length} proofs fail`;
  if (sent.round === "tests") return "the tests fail";
  if (sent.round === "models") return sent.models.length === 0 ? "a model declares no header" : sent.models.length === 1 ? "a model fails" : `${sent.models.length} models fail`;
  return sent.contracts.length === 1 ? "a contract is too weak" : `${sent.contracts.length} contracts are too weak`;
}

/**
 * What the gate sent back, as a card: what fails, one row each; expanded,
 * their details and the text the agent read, as it read it.
 */
function sentBackCard(theme: Theme, sent: SentBack, content: string, options: RenderOptions): Component {
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
  pi.registerMessageRenderer("tesota-receipt-graphs", (message, options, theme) => {
    const details = message.details as ReceiptGraphMessage | undefined;
    return details !== undefined && isReceipt(details.receipt) && Array.isArray(details.graphs)
      ? receiptCard(theme, details.receipt, options, details.graphs) : undefined;
  });
  pi.registerMessageRenderer("tesota-ledger", (message, options, theme) =>
    isLedger(message.details) ? ledgerCard(theme, message.details, options) : undefined);
  pi.registerMessageRenderer("tesota-gate", (message, options, theme) =>
    message.details === undefined ? undefined : sentBackCard(theme, message.details as SentBack, text(message.content), options));
}
