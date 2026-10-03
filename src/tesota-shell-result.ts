import { ScrollView, VStack, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent,
  type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DiffView } from "./tesota-shell-diff.js";
import { bold, mutedText, selectedRow, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { recordRows } from "./tesota-shell-transcript.js";

export type ResultTab = "review" | "checks" | "guarantees" | "diff";
const RESULT_TABS: readonly ResultTab[] = ["review", "checks", "guarantees", "diff"];
const tabLabels: Readonly<Record<ResultTab, string>> = { review: "Review", checks: "Checks", guarantees: "Guarantees", diff: "Diff" };

/** A record's text for each tab that shows part of it. */
export type RecordTabs = Readonly<{ review: string; checks: string; guarantees: string }>;

/**
 * A record split for its tabs: its Checks section, which the Checks tab
 * shows, its Guarantees section, which the Guarantees tab shows, and the
 * rest, which the Review tab shows. A section starts at an unindented line
 * after a blank one; everything nested in it is indented.
 */
export function resultSections(record: string): RecordTabs {
  const sections = recordSections(record);
  const heading = (section: string): string => section.split("\n", 1)[0] ?? "";
  return { review: sections.filter((section) => !["Checks", "Guarantees"].includes(heading(section))).join("\n\n"),
    checks: sections.filter((section) => heading(section) === "Checks").join("\n\n"),
    guarantees: sections.filter((section) => heading(section) === "Guarantees").join("\n\n") };
}

/** The headings a record's sections have, as `src/tesota-shell-inspection.ts` writes them; "Requested" in earlier records. */
const RECORD_HEADINGS: ReadonlySet<string> = new Set(["Your requests", "Requested", "First pass", "Files",
  "Changes to how the result is checked", "Checks", "Guarantees", "Review", "Content"]);
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

/** Where the Diff tab's diff comes from. */
export type DiffSource = "reviewed" | "undecided" | "working";
const DIFF_SOURCES: readonly DiffSource[] = ["reviewed", "undecided", "working"];
const sourceLabels: Readonly<Record<DiffSource, string>> = { reviewed: "Reviewed", undecided: "Undecided", working: "Working tree" };

/**
 * The Diff tab's sources besides the reviewed result, read where the session
 * works when asked: everything uncommitted there, and its undecided turns
 * together, which Keep and Revert act on. Each is undefined where it does not
 * apply, as undecided turns in a copy.
 */
export interface DiffSources {
  readonly working?: string | undefined;
  readonly undecided?: string | undefined;
}

/**
 * The result panel: a heading and the tabs Review, Checks and Diff that the
 * result has, as a pull request separates its conversation, checks and files.
 * Alt+T steps through the tabs, and a click or a tap on one chooses it, so a
 * phone over SSH reaches each without a key it lacks. Each tab scrolls on its
 * own and keeps its place. The Diff tab shows one source at a time, as Claude
 * Code's diff panel does: the reviewed result, which its checks and review
 * describe; the undecided turns; or everything uncommitted, live.
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
  #sections: RecordTabs = { review: "", checks: "", guarantees: "" };
  /** Each source's diff once known; the reviewed one with the result, the others when the operator asks for them. */
  #diffs: Partial<Record<DiffSource, string>> = {};
  #source: DiffSource = "reviewed";
  #tab: ResultTab = "review";
  /** Where each tab's label and the source's were drawn in the tab row, for a click to choose one. */
  #labels: { target: ResultTab | "source"; start: number; end: number }[] = [];
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
    const diff = new TabBody((width) => {
      const lines = this.diff.render(width);
      return lines.length > 0 ? lines : [` ${mutedText(`No changes in the ${sourceLabels[this.#source].toLowerCase()}.`, this.#theme)}`];
    });
    const bodies = { review: record(() => this.#sections.review), checks: record(() => this.#sections.checks),
      guarantees: record(() => this.#sections.guarantees), diff };
    this.#bodies = Object.values(bodies);
    const scroll = (tab: ResultTab): ScrollView => new ScrollView(bodies[tab], { scrollbar: "auto" });
    this.#scrolls = { review: scroll("review"), checks: scroll("checks"), guarantees: scroll("guarantees"), diff: scroll("diff") };
    const header: Component = { render: (width) => this.#header(width), invalidate: () => undefined,
      handleMouse: (event) => this.#mouse(event) };
    this.view = new VStack([{ component: header, basis: "auto", shrink: 0 },
      ...RESULT_TABS.map((tab) => ({ component: this.#scrolls[tab], basis: 0, grow: 1, minSize: 1,
        visible: () => tab === this.#tab }))]);
  }

  get tab(): ResultTab { return this.#tab; }
  get source(): DiffSource { return this.#source; }
  get width(): number | undefined { return this.#width; }

  /** The sources the Diff tab can show: the reviewed result when it changed files, and each other one once read. */
  get sources(): readonly DiffSource[] {
    return DIFF_SOURCES.filter((source) => source === "reviewed" ? (this.#diffs.reviewed ?? "").trim().length > 0
      : this.#diffs[source] !== undefined);
  }

  /**
   * The tabs this result has: Review with a record or nothing else to show, Checks when checks ran, Guarantees when
   * the change touched a contract, Diff with a source.
   */
  get tabs(): readonly ResultTab[] {
    const diff = this.sources.length > 0;
    return RESULT_TABS.filter((tab) => tab === "review" ? this.#sections.review.length > 0 || !diff
      : tab === "diff" ? diff : this.#sections[tab].length > 0);
  }

  /** Show a styled heading and a result's record and diff, from its first tab's start: another result begins anew. */
  show(heading: string, record = "", diff?: string): void {
    const shown = JSON.stringify([heading, record, diff ?? ""]);
    if (shown === this.#shown) return;
    this.#shown = shown;
    this.#heading = heading;
    this.#sections = resultSections(record);
    this.#diffs = diff === undefined ? {} : { reviewed: diff };
    this.#source = "reviewed";
    this.diff.setDiff(diff);
    this.invalidate();
    this.#tab = this.tabs[0] ?? "review";
    for (const scroll of Object.values(this.#scrolls)) scroll.scrollToStart();
  }

  /** Take the sources read where the session works, keeping the one shown when it is still there. */
  setSources(sources: DiffSources): void {
    this.#diffs = { ...this.#diffs.reviewed === undefined ? {} : { reviewed: this.#diffs.reviewed },
      ...sources.undecided === undefined ? {} : { undecided: sources.undecided },
      ...sources.working === undefined ? {} : { working: sources.working } };
    // With no reviewed result, everything uncommitted first, as Claude Code's diff opens on the current changes.
    const fallback = (["reviewed", "working", "undecided"] as const).find((source) => this.sources.includes(source));
    this.#showSource(this.sources.includes(this.#source) ? this.#source : fallback ?? "reviewed");
  }

  /** Show a source the panel has on the Diff tab; another is ignored. */
  chooseSource(source: DiffSource): void {
    if (!this.sources.includes(source)) return;
    this.#showSource(source);
    this.choose("diff");
    this.#onChange();
  }

  #showSource(source: DiffSource): void {
    const changed = source !== this.#source;
    this.#source = source;
    this.diff.setDiff(this.#diffs[source]);
    this.invalidate();
    if (changed) this.#scrolls.diff.scrollToStart();
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
    if (!tabs.includes(this.#tab)) this.#tab = tabs[0] ?? "review";
    this.#labels = [];
    // The tab row shows with more than one tab, and always on the Diff tab, where it names the source.
    if (tabs.length < 2 && this.#tab !== "diff") { this.#tabRow = undefined; return lines; }
    let column = 1;
    const labels = tabs.map((tab) => {
      const label = ` ${tabLabels[tab]} `;
      this.#labels.push({ target: tab, start: column, end: column + label.length });
      column += label.length;
      return tab === this.#tab ? bold(selectedRow(label, label.length, this.#theme)) : mutedText(label, this.#theme);
    });
    const row = ` ${labels.join("")}`;
    const several = this.sources.length > 1;
    const source = this.#tab === "diff" ? `source: ${sourceLabels[this.#source]}${several ? " ▾" : ""}` : "";
    const hint = [source, tabs.length > 1 ? "Alt+T" : ""].filter(Boolean).join(" · ");
    const gap = width - visibleWidth(row) - visibleWidth(hint) - 1;
    this.#tabRow = lines.length;
    if (gap < 2) return [...lines, truncateToWidth(row, width)];
    // The source is chosen by clicking its name, which steps to the next one.
    if (source.length > 0 && several) this.#labels.push({ target: "source", start: column + gap, end: column + gap + source.length });
    return [...lines, `${row}${" ".repeat(gap)}${mutedText(hint, this.#theme)}`];
  }

  /** A press on a tab's label, or the source's, is taken, so the click that follows it reaches here and acts. */
  #mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    const label = event.y === this.#tabRow ? this.#labels.find(({ start, end }) => event.x >= start && event.x < end) : undefined;
    if (label === undefined) return undefined;
    if (event.type === "click") {
      if (label.target !== "source") this.choose(label.target);
      else this.chooseSource(this.sources[(this.sources.indexOf(this.#source) + 1) % this.sources.length] ?? this.#source);
    }
    return { handled: true, render: event.type === "click" };
  }
}
