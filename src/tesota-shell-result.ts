import { ScrollView, VStack, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent,
  type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DiffView } from "./tesota-shell-diff.js";
import { bold, mutedText, selectedRow, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { recordRows } from "./tesota-shell-transcript.js";

export type ResultTab = "review" | "checks" | "diff";
const RESULT_TABS: readonly ResultTab[] = ["review", "checks", "diff"];
const tabLabels: Readonly<Record<ResultTab, string>> = { review: "Review", checks: "Checks", diff: "Diff" };

/**
 * A record split for its tabs: its Checks section, which the Checks tab
 * shows, and the rest, which the Review tab shows. A section starts at an
 * unindented line after a blank one; everything nested in it is indented.
 */
export function resultSections(record: string): Readonly<{ review: string; checks: string }> {
  const sections = recordSections(record);
  const isChecks = (section: string): boolean => section.split("\n", 1)[0] === "Checks";
  return { review: sections.filter((section) => !isChecks(section)).join("\n\n"),
    checks: sections.filter(isChecks).join("\n\n") };
}

/** The headings a record's sections have, as `src/tesota-shell-inspection.ts` writes them; "Requested" in earlier records. */
const RECORD_HEADINGS: ReadonlySet<string> = new Set(["Your requests", "Requested", "First pass", "Files",
  "Changes to how the result is checked", "Checks", "Review", "Content"]);
const REQUEST_HEADINGS: ReadonlySet<string> = new Set(["Your requests", "Requested"]);

/**
 * A record's sections, each starting at an unindented line after a blank one.
 * Records saved before a request's own lines were kept under its number have
 * them unindented, where they would read as headings: what follows the
 * requests under no heading of the record's own is theirs, drawn indented.
 */
export function recordSections(record: string): string[] {
  const sections: string[] = [];
  let requests = false;
  for (const section of record.length === 0 ? [] : record.split(/\n\n(?=\S)/u)) {
    const heading = section.split("\n", 1)[0] ?? "";
    if (requests && !RECORD_HEADINGS.has(heading)) {
      sections[sections.length - 1] += `\n\n${section}`;
      continue;
    }
    sections.push(section);
    requests = REQUEST_HEADINGS.has(heading);
  }
  return sections.map((section) => {
    const [heading = "", ...lines] = section.split("\n");
    if (!REQUEST_HEADINGS.has(heading)) return section;
    return [heading, ...lines.map((line) => line.length === 0 || line.startsWith(" ") ? line : `     ${line}`)].join("\n");
  });
}

/** The tab after `tab` among those a result has, wrapping around. */
export function nextResultTab(tabs: readonly ResultTab[], tab: ResultTab): ResultTab {
  return tabs[(tabs.indexOf(tab) + 1) % tabs.length] ?? "review";
}

/** One tab's content: a record's rows, or the diff. */
class TabBody implements Component {
  readonly #rows: (width: number) => string[];
  #cached: { width: number; lines: string[] } | undefined;
  constructor(rows: (width: number) => string[]) { this.#rows = rows; }
  invalidate(): void { this.#cached = undefined; }
  render(width: number): string[] {
    if (this.#cached?.width !== width) this.#cached = { width, lines: this.#rows(width) };
    return this.#cached.lines;
  }
}

/**
 * The result panel: a heading and, when a result has more than its review,
 * the tabs Review, Checks and Diff, as a pull request separates its
 * conversation, checks and files. Alt+T steps through the tabs, and a click
 * or a tap on one chooses it, so a phone over SSH reaches each without a key
 * it lacks. Each tab scrolls on its own and keeps its place.
 */
export class ResultPanel {
  readonly diff: DiffView;
  /** The panel as one component for the layout: the heading and tabs above the chosen tab's scrolling content. */
  readonly view: VStack;
  readonly #theme: TesotaShellTheme;
  readonly #scrolls: Readonly<Record<ResultTab, ScrollView>>;
  readonly #bodies: readonly TabBody[];
  readonly #onChange: () => void;
  #heading = "";
  /** What the panel shows, so showing the same result again keeps its tab and places. */
  #shown = "";
  #hasDiff = false;
  #sections: Readonly<{ review: string; checks: string }> = { review: "", checks: "" };
  #tab: ResultTab = "review";
  /** Where each tab's label was drawn in the tab row, for a click to choose it. */
  #labels: { tab: ResultTab; start: number; end: number }[] = [];
  #tabRow: number | undefined;
  /** The width the panel was last drawn at, for the surface laid under its column. */
  #width: number | undefined;

  constructor(theme: TesotaShellTheme, onChange: () => void) {
    this.#theme = theme;
    this.#onChange = onChange;
    this.diff = new DiffView(theme);
    // Each section is a block under a rule, as each file is in the diff.
    const record = (text: () => string) => new TabBody((width) => {
      const inner = Math.max(1, width - 2);
      const rule = mutedText("─".repeat(width), this.#theme);
      return recordSections(text()).flatMap((section, index) =>
        [...index === 0 ? [] : [""], rule, ...recordRows(section, inner, this.#theme, true).map((row) => ` ${row}`)]);
    });
    const bodies = { review: record(() => this.#sections.review), checks: record(() => this.#sections.checks),
      diff: new TabBody((width) => this.diff.render(width)) };
    this.#bodies = Object.values(bodies);
    const scroll = (tab: ResultTab): ScrollView => new ScrollView(bodies[tab], { scrollbar: "auto" });
    this.#scrolls = { review: scroll("review"), checks: scroll("checks"), diff: scroll("diff") };
    const header: Component = { render: (width) => this.#header(width), invalidate: () => undefined,
      handleMouse: (event) => this.#mouse(event) };
    this.view = new VStack([{ component: header, basis: "auto", shrink: 0 },
      ...RESULT_TABS.map((tab) => ({ component: this.#scrolls[tab], basis: 0, grow: 1, minSize: 1,
        visible: () => tab === this.#tab }))]);
  }

  get tab(): ResultTab { return this.#tab; }
  get width(): number | undefined { return this.#width; }

  /** The tabs this result has: Review always, Checks when checks ran, and Diff when it changed files. */
  get tabs(): readonly ResultTab[] {
    return RESULT_TABS.filter((tab) => tab === "review" || (tab === "checks" ? this.#sections.checks.length > 0 :
      this.#hasDiff));
  }

  /** Show a styled heading and a result's record and diff, from its Review tab's start: another result begins anew. */
  show(heading: string, record = "", diff?: string): void {
    const shown = JSON.stringify([heading, record, diff ?? ""]);
    if (shown === this.#shown) return;
    this.#shown = shown;
    this.#heading = heading;
    this.#sections = resultSections(record);
    this.#hasDiff = diff !== undefined && diff.trim().length > 0;
    this.diff.setDiff(diff);
    this.invalidate();
    this.#tab = "review";
    for (const scroll of Object.values(this.#scrolls)) scroll.scrollToStart();
  }

  /** Choose a tab the result has; another is ignored. */
  choose(tab: ResultTab): void {
    if (!this.tabs.includes(tab) || tab === this.#tab) return;
    this.#tab = tab;
    this.#onChange();
  }

  next(): void { this.choose(nextResultTab(this.tabs, this.#tab)); }

  invalidate(): void {
    this.diff.invalidate();
    for (const body of this.#bodies) body.invalidate();
  }

  #header(width: number): string[] {
    this.#width = width;
    const inner = Math.max(1, width - 2);
    const lines = wrapTextWithAnsi(this.#heading, inner).map((row) => ` ${row}`);
    const tabs = this.tabs;
    if (!tabs.includes(this.#tab)) this.#tab = "review";
    this.#labels = [];
    if (tabs.length < 2) { this.#tabRow = undefined; return lines; }
    let column = 1;
    const labels = tabs.map((tab) => {
      const label = ` ${tabLabels[tab]} `;
      this.#labels.push({ tab, start: column, end: column + label.length });
      column += label.length;
      return tab === this.#tab ? bold(selectedRow(label, label.length, this.#theme)) : mutedText(label, this.#theme);
    });
    const hint = mutedText("Alt+T", this.#theme);
    const row = ` ${labels.join("")}`;
    const gap = width - visibleWidth(row) - visibleWidth(hint) - 1;
    this.#tabRow = lines.length;
    return [...lines, truncateToWidth(gap >= 2 ? `${row}${" ".repeat(gap)}${hint}` : row, width)];
  }

  /** A press on a tab's label is taken, so the click that follows it reaches here and chooses that tab. */
  #mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const label = event.y === this.#tabRow ? this.#labels.find(({ start, end }) => event.x >= start && event.x < end) : undefined;
    if (label === undefined) return undefined;
    if (event.type === "click") this.choose(label.tab);
    return { handled: true, render: event.type === "click" };
  }
}
