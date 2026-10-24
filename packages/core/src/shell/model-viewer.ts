import { type Component, Input, type KeyId, matchesKey, sliceByColumn, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth,
  visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ThemeColor } from "../../../../src/contract.ts";
import { adjacentViolation, boundedCount, type ModelView, type ViewGroup, type ViewRequest, type ViewState } from "../../../../src/model-view.ts";
import { terminalText } from "../../../../src/terminal-text.ts";
import type { ShellTheme } from "../../../../src/theme.ts";

/** What the viewer is given: how to read a view through step 3a's disposable worker, and how to go away again. */
export interface ModelViewerOptions {
  readonly theme: ShellTheme;
  /** The model the graph is of, as the receipt names it. */
  readonly subject: string;
  readonly rows: () => number;
  /** One request, one worker; the signal stops it when the view is no longer wanted. */
  readonly load: (request: ViewRequest, signal: AbortSignal) => Promise<ModelView>;
  readonly close: () => void;
  /** Draws the shell again once a view arrives. */
  readonly redraw: () => void;
}

/** The smallest terminal the full-screen viewer draws in; a smaller one gets the graph appended as text. */
export const fullScreen = { columns: 40, rows: 12 } as const;
export const fitsFullScreen = (columns: number, rows: number): boolean => columns >= fullScreen.columns && rows >= fullScreen.rows;

/** The lines of step 3a's text rendering an append-only terminal is given; the rest is a command away. */
export function appendOnlyText(view: ModelView, manifest: string, limit = 400): string {
  const lines = terminalText(view.plain).split("\n");
  return [...lines.slice(0, limit), ...lines.length > limit ? [`… ${lines.length - limit} more lines: tesota graph --plain ${oneLine(manifest)}`] : []].join("\n");
}

// Each detail level's box width, height and the gap between ranks, as the prototype drew them.
const widths = [24, 34, 44] as const, heights = [4, 5, 6] as const, gaps = [4, 12, 16] as const;
const header = 3;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Box { readonly group: ViewGroup; readonly number: number; readonly x: number; readonly y: number }
interface Layout { readonly boxes: readonly Box[]; readonly width: number; readonly height: number; readonly byGroup: ReadonlyMap<string, Box> }
interface Line { readonly text: string; readonly role: ThemeColor }
interface Saved { readonly request: ViewRequest; readonly view: ModelView; readonly selected: string | undefined; readonly pan: readonly [number, number]; readonly within: string }

/** Ranks of groups by breadth-first distance from the initial state's group; a group nothing reaches starts a rank of its own. */
function ranks(view: ModelView): { readonly rank: ReadonlyMap<string, number>; readonly deepest: number } {
  const membership = new Map(view.groups.flatMap((group) => group.members.map((id) => [id, group.id] as const)));
  const next = new Map<string, string[]>();
  for (const edge of view.edges) if (edge.from !== edge.to) next.set(edge.from, [...next.get(edge.from) ?? [], edge.to]);
  const rank = new Map<string, number>();
  const start = membership.get(view.trace[0]?.fingerprint ?? "") ?? membership.get(view.states[0]?.fingerprint ?? "");
  let deepest = -1;
  for (const root of [...start === undefined ? [] : [start], ...view.groups.map(({ id }) => id)]) {
    if (rank.has(root)) continue;
    rank.set(root, deepest + 1);
    for (const queue = [root]; queue.length > 0;) {
      const at = queue.shift() ?? root, depth = rank.get(at) ?? 0;
      deepest = Math.max(deepest, depth);
      for (const to of next.get(at) ?? []) if (!rank.has(to)) { rank.set(to, depth + 1); queue.push(to); }
    }
  }
  return { rank, deepest };
}

/** Each group's box, a column a rank. */
function layout(view: ModelView, detail: number): Layout {
  const { rank, deepest } = ranks(view);
  const w = widths[detail] ?? 24, h = heights[detail] ?? 4, gap = gaps[detail] ?? 4;
  const columns = new Map<number, ViewGroup[]>();
  for (const group of view.groups) { const r = rank.get(group.id) ?? 0; columns.set(r, [...columns.get(r) ?? [], group]); }
  const boxes: Box[] = [];
  let tallest = 0;
  for (const r of [...columns.keys()].sort((a, b) => a - b)) {
    const column = columns.get(r) ?? [];
    tallest = Math.max(tallest, column.length);
    column.forEach((group, row) => { boxes.push({ group, number: boxes.length + 1, x: r * (w + gap), y: row * (h + 1) }); });
  }
  return { boxes, width: Math.max(0, (deepest + 1) * (w + gap) - gap), height: Math.max(0, tallest * (h + 1) - 1),
    byGroup: new Map(boxes.map((box) => [box.group.id, box])) };
}

/** The variables of a state as TLC printed them, one assignment a line. */
const assignments = (valuation: string): string[] => terminalText(valuation).split("\n").map((line) => line.replace(/^\s*\/\\\s?/u, ""));
/**
 * Text a manifest or a worker gave, made safe for one row: control sequences removed, lines joined. Every such
 * string reaches the screen through it: a manifest's names and values are untrusted.
 */
const oneLine = (text: string): string => terminalText(text).replace(/\s*\n\s*/gu, " ");
/** `text` in at most `width` terminal columns, marked where cut; padded to `width` when `pad`. */
const fit = (text: string, width: number, pad = false): string => truncateToWidth(oneLine(text), Math.max(0, width), "…", pad);
/** `text` in rows of at most `width` terminal columns, every character kept. */
const wrapped = (text: string, width: number): string[] => {
  const rows = wrapTextWithAnsi(oneLine(text), Math.max(1, width));
  return rows.length === 0 ? [""] : rows;
};

/**
 * The full-screen model graph (#592), mounted through the shell's overlay as
 * the dashboard is. It holds only what step 3a's worker returns: each regroup,
 * drill and search is one more disposable worker. Counts on a partial graph
 * read as lower bounds, a group's `! BREAK` counts its reported violating
 * members, and only TLC's trace is called an execution.
 */
export class ModelViewer implements Component {
  #view: ModelView | undefined;
  #request: ViewRequest = {};
  #within = "";
  readonly #parents: Saved[] = [];
  #selected: string | undefined;
  #error: string | undefined;
  #notice = "";
  #detail = 0;
  #pan: [number, number] = [0, 0];
  #panelTop = 0;
  #trace: { readonly selected: string | undefined; readonly pan: readonly [number, number] } | undefined;
  #prompt: { readonly kind: "group" | "search"; readonly input: Input; status: string; error: boolean } | undefined;
  #search: { readonly query: string; readonly matches: readonly string[]; index: number } | undefined;
  #controller: AbortController | undefined;
  #closed = false;
  #reveal = true;
  #drag: { readonly x: number; readonly y: number; readonly pan: readonly [number, number] } | undefined;
  #canvas = { x: 0, y: header, w: 1, h: 1 };
  #layout: { readonly view: ModelView; readonly detail: number; readonly layout: Layout } | undefined;

  readonly options: ModelViewerOptions;

  constructor(options: ModelViewerOptions) {
    this.options = options;
    this.#load({}, (view) => {
      this.#view = view;
      this.#selected = view.violations[0] ?? view.states[0]?.fingerprint;
    }, (reason) => { this.#error = reason; });
  }

  #load(request: ViewRequest, then: (view: ModelView) => void, fail: (reason: string) => void): void {
    this.#controller?.abort();
    const controller = new AbortController();
    this.#controller = controller;
    this.options.load(request, controller.signal).then((view) => {
      if (this.#closed || controller !== this.#controller) return;
      this.#controller = undefined;
      then(view);
      this.#reveal = true;
      this.options.redraw();
    }, (error: unknown) => {
      if (this.#closed || controller !== this.#controller) return;
      this.#controller = undefined;
      fail(error instanceof Error ? error.message : String(error));
      this.options.redraw();
    });
  }

  /** Releases the worker when either the viewer or its owning shell closes. */
  dispose(): void {
    this.#closed = true;
    this.#controller?.abort();
    this.#controller = undefined;
  }

  #close(): void {
    this.dispose();
    this.options.close();
  }

  #select(id: string | undefined): void {
    if (id === undefined) return;
    this.#selected = id;
    this.#panelTop = 0;
    this.#reveal = true;
  }

  #state(id: string | undefined): ViewState | undefined { return this.#view?.states.find((state) => state.fingerprint === id); }
  #count(n: number): string { return boundedCount(this.#view?.partial ?? false, n); }
  #layoutOf(view: ModelView): Layout {
    if (this.#layout?.view !== view || this.#layout.detail !== this.#detail) this.#layout = { view, detail: this.#detail, layout: layout(view, this.#detail) };
    return this.#layout.layout;
  }

  #openPrompt(kind: "group" | "search"): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value) => { if (kind === "group") this.#regroup(value); else this.#find(value.trim()); };
    this.#prompt = { kind, input, status: "", error: false };
  }

  #regroup(text: string): void {
    const prompt = this.#prompt;
    const projection = text.split(",").map((name) => name.trim()).filter((name) => name !== "");
    const request = { ...this.#request, projection };
    this.#load(request, (view) => {
      this.#request = request;
      this.#view = view;
      this.#search = undefined;
      if (this.#prompt === prompt) this.#prompt = undefined;
      if (this.#state(this.#selected) === undefined) this.#select(view.violations[0] ?? view.states[0]?.fingerprint);
    }, (reason) => { if (prompt !== undefined) { prompt.status = reason; prompt.error = true; } });
  }

  #find(query: string): void {
    const prompt = this.#prompt;
    if (prompt === undefined) return;
    if (query === "") { prompt.status = "Type a fingerprint, a variable's value or an invariant."; prompt.error = true; return; }
    const step = (): void => {
      const search = this.#search;
      if (search === undefined) return;
      if (search.matches.length === 0) { prompt.status = "No reached state matches; search covers the captured states only."; prompt.error = true; return; }
      this.#select(search.matches[search.index]);
      prompt.status = `Match ${search.index + 1}/${search.matches.length}`;
      prompt.error = false;
    };
    if (this.#search?.query === query) {
      this.#search.index = (this.#search.index + 1) % Math.max(1, this.#search.matches.length);
      step();
      return;
    }
    this.#load({ ...this.#request, search: query }, (view) => {
      this.#view = view;
      this.#search = { query, matches: view.matches, index: 0 };
      step();
    }, (reason) => { prompt.status = reason; prompt.error = true; });
  }

  #drill(): void {
    const view = this.#view;
    const group = view?.groups.find((each) => each.members.includes(this.#selected ?? ""));
    if (view === undefined || group === undefined) return;
    if (group.path.length === 0) { this.#notice = "Each group here is one reached state; its variables are on the side."; return; }
    const within = [this.#within, group.path.map(([name, value]) => `${name} = ${value}`).join(" › ")].filter((part) => part !== "").join(" › ");
    const request = { projection: [], members: group.members };
    const saved: Saved = { request: this.#request, view, selected: this.#selected, pan: this.#pan, within: this.#within };
    this.#load(request, (inner) => {
      this.#parents.push(saved);
      this.#request = request;
      this.#view = inner;
      this.#within = within;
      this.#search = undefined;
      this.#pan = [0, 0];
      this.#notice = `${this.#count(group.members.length)} reached members of the group; ${this.#count(inner.boundary)} edges cross its boundary.`;
    }, (reason) => { this.#notice = reason; });
  }

  #back(): void {
    if (this.#prompt !== undefined) { this.#prompt = undefined; return; }
    if (this.#trace !== undefined) { this.#toggleTrace(); return; }
    const parent = this.#parents.pop();
    if (parent === undefined) { this.#close(); return; }
    this.#controller?.abort();
    this.#controller = undefined;
    this.#request = parent.request;
    this.#view = parent.view;
    this.#selected = parent.selected;
    this.#pan = [...parent.pan];
    this.#within = parent.within;
    this.#search = undefined;
    this.#notice = "";
  }

  #toggleTrace(): void {
    const view = this.#view;
    if (view === undefined) return;
    if (this.#trace !== undefined) {
      this.#selected = this.#trace.selected;
      this.#pan = [...this.#trace.pan];
      this.#trace = undefined;
      this.#notice = "";
      return;
    }
    if (view.trace.length === 0) { this.#notice = "TLC reported no trace for this run; the graph stays."; return; }
    this.#trace = { selected: this.#selected, pan: this.#pan };
    this.#pan = [0, 0];
    if (!view.trace.some(({ fingerprint }) => fingerprint === this.#selected)) this.#select(view.trace.at(-1)?.fingerprint);
    this.#notice = "";
  }

  #jump(direction: 1 | -1): void {
    const view = this.#view;
    if (view === undefined) return;
    const next = adjacentViolation(view, this.#selected, direction);
    if (next === undefined) { this.#notice = "TLC reported no violating state here; zero reports do not establish safety."; return; }
    if (this.#trace !== undefined) this.#toggleTrace();
    this.#select(next);
    this.#notice = `! BREAK ${view.violations.indexOf(next) + 1}/${view.violations.length} · ${(this.#state(next)?.breaks ?? []).join(", ")}`;
  }

  #step(direction: 1 | -1): void {
    const view = this.#view;
    if (view === undefined) return;
    const ids = this.#trace !== undefined ? view.trace.map(({ fingerprint }) => fingerprint) : view.states.map(({ fingerprint }) => fingerprint);
    if (ids.length === 0) return;
    const at = ids.indexOf(this.#selected ?? "");
    this.#select(ids[at < 0 ? 0 : (at + direction + ids.length) % ids.length]);
  }

  #panBy(x: number, y: number): void { this.#pan = [this.#pan[0] + x, this.#pan[1] + y]; }

  handleInput(data: string): void {
    const prompt = this.#prompt;
    if (prompt !== undefined) {
      if (matchesKey(data, "escape")) this.#prompt = undefined;
      else prompt.input.handleInput(data);
      return;
    }
    if (matchesKey(data, "escape")) { this.#back(); return; }
    if (this.#view === undefined) return;
    this.#keys.find(([key]) => data === key || matchesKey(data, key as KeyId))?.[1]();
  }

  /** Each key and what it does once a view has arrived; `g`, `/` and Enter act on the grouped graph, not the trace. */
  readonly #keys: readonly (readonly [string, () => void])[] = [
    ["+", () => { this.#detail = Math.min(2, this.#detail + 1); this.#reveal = true; }],
    ["=", () => { this.#detail = Math.min(2, this.#detail + 1); this.#reveal = true; }],
    ["-", () => { this.#detail = Math.max(0, this.#detail - 1); this.#reveal = true; }],
    ["g", () => { if (this.#trace === undefined) this.#openPrompt("group"); }],
    ["/", () => { if (this.#trace === undefined) this.#openPrompt("search"); }],
    ["n", () => { this.#jump(1); }],
    ["p", () => { this.#jump(-1); }],
    ["t", () => { this.#toggleTrace(); }],
    ["enter", () => { if (this.#trace === undefined) this.#drill(); }],
    ["tab", () => { this.#step(1); }],
    ["shift+tab", () => { this.#step(-1); }],
    ["left", () => { this.#panBy(-8, 0); }],
    ["right", () => { this.#panBy(8, 0); }],
    ["up", () => { this.#panBy(0, -3); }],
    ["down", () => { this.#panBy(0, 3); }],
    ["pageUp", () => { this.#panelTop = Math.max(0, this.#panelTop - 8); }],
    ["pageDown", () => { this.#panelTop += 8; }],
  ];

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const { x, y, w, h } = this.#canvas;
    const inCanvas = event.x >= x && event.x < x + w && event.y >= y && event.y < y + h;
    // The wheel is always the viewer's: the transcript under it keeps its place.
    if (event.type === "wheel") {
      const step = Math.sign(event.wheelDelta ?? 0);
      if (inCanvas) this.#panBy(0, 3 * step); else this.#panelTop = Math.max(0, this.#panelTop + 3 * step);
      return { handled: true };
    }
    if (event.type === "press" && event.button === "left" && inCanvas) {
      this.#drag = { x: event.x, y: event.y, pan: this.#pan };
      this.#pick(event.x - x + this.#pan[0], event.y - y + this.#pan[1]);
      return { capture: true };
    }
    if (event.type === "drag" && this.#drag !== undefined) {
      this.#pan = [this.#drag.pan[0] + this.#drag.x - event.x, this.#drag.pan[1] + this.#drag.y - event.y];
      return { handled: true };
    }
    if (event.type === "release" && this.#drag !== undefined) { this.#drag = undefined; return { handled: true, render: true }; }
    return undefined;
  }

  /** The state under a click: a trace step, or a group's first violating member, else its first. */
  #pick(x: number, y: number): void {
    const view = this.#view;
    if (view === undefined) return;
    if (this.#trace !== undefined) {
      const step = view.trace[Math.floor(y / 3)];
      if (step !== undefined && y % 3 !== 2) { this.#selected = step.fingerprint; this.#panelTop = 0; }
      return;
    }
    const w = widths[this.#detail] ?? 24, h = heights[this.#detail] ?? 4;
    const box = this.#layoutOf(view).boxes.find((each) => x >= each.x && x < each.x + w && y >= each.y && y < each.y + h);
    if (box === undefined) return;
    this.#selected = box.group.members.find((id) => (this.#state(id)?.breaks.length ?? 0) > 0) ?? box.group.members[0];
    this.#panelTop = 0;
  }

  invalidate(): void { this.#layout = undefined; }

  render(width: number): string[] {
    const { theme } = this.options;
    const rows = Math.max(fullScreen.rows, this.options.rows());
    const view = this.#view;
    const title = `Model graph · ${oneLine(this.options.subject)}`;
    const bottom = this.#bottom(width);
    const bodyHeight = Math.max(1, rows - header - bottom.length);
    if (view === undefined) {
      const said = this.#error === undefined ? "Reading the graph in its own worker…" : `The graph could not be read: ${oneLine(this.#error)}`;
      return this.#frame([theme.fg("accent", theme.bold(title)), theme.fg(this.#error === undefined ? "muted" : "error", said), "",
        ...Array.from({ length: bodyHeight }, () => ""), ...bottom], width, rows);
    }
    const side = width >= 72;
    const panelWidth = side ? Math.min(44, Math.max(28, Math.floor(width * 0.34))) : width;
    const panelHeight = side ? bodyHeight : Math.min(8, Math.floor(bodyHeight / 2));
    this.#canvas = { x: 0, y: header, w: side ? width - panelWidth - 1 : width, h: side ? bodyHeight : Math.max(1, bodyHeight - panelHeight - 1) };
    const canvas = this.#trace !== undefined ? this.#traceCanvas(view) : this.#graphCanvas(view);
    const panel = this.#panel(view, panelWidth, panelHeight);
    const body = side
      ? canvas.map((row, at) => `${row}${theme.fg("borderMuted", "│")}${panel[at] ?? ""}`)
      : [...canvas, theme.fg("borderMuted", "─".repeat(width)), ...panel];
    const reached = view.edges.reduce((sum, edge) => sum + edge.count, 0);
    const counts = [view.partial ? "Partial exploration; counts are lower bounds" : "Complete exploration; exact counts",
      `reached ${this.#count(view.states.length)}`,
      this.#parents.length === 0 ? `edges ${this.#count(reached + view.boundary)}` : `edges inside ${this.#count(reached)} · crossing ${this.#count(view.boundary)}`,
      `reported violating ${this.#count(view.violations.length)}${view.violations.length === 0 ? " (zero reports do not establish safety)" : ""}`].join(" · ");
    const grouping = view.projection.length === 0 ? "each state" : oneLine(view.projection.join(" > "));
    const top = this.#trace !== undefined
      ? [`${title} · TLC concrete trace`, counts, `TLC concrete trace · ${view.trace.length} steps · the only execution shown, not regrouped or filtered`]
      : [`${title} · grouped by ${grouping} · ${this.#within === "" ? "all reached states" : `within ${oneLine(this.#within)}`}`, counts,
        "Grouped transitions are not an execution; t shows TLC's concrete trace."];
    return this.#frame([theme.fg("accent", theme.bold(top[0] ?? "")), theme.fg(view.partial ? "warning" : "muted", top[1] ?? ""),
      theme.fg("muted", top[2] ?? ""), ...body, ...bottom], width, rows);
  }

  #frame(lines: readonly string[], width: number, rows: number): string[] {
    return Array.from({ length: rows }, (_, at) => truncateToWidth(lines[at] ?? "", width, "", true));
  }

  /** The notice or the open prompt, then the keys. */
  #bottom(width: number): string[] {
    const { theme } = this.options;
    const keys = theme.fg("dim", fit(`detail ${this.#detail + 1}/3 · pan ${this.#pan[0]},${this.#pan[1]} · arrows/drag pan · +/- detail · g group · Enter drill · `
      + "n/p break · t trace · / search · Tab state · PgUp/PgDn variables · Esc back", width));
    const prompt = this.#prompt;
    if (prompt === undefined) return [theme.fg(this.#notice.startsWith("!") ? "error" : "muted", oneLine(this.#notice)), keys];
    const asked = prompt.kind === "group"
      ? `Group by: up to two variables, comma-separated; empty for each state (now ${oneLine(this.#view?.projection.join(", ") ?? "") || "each state"})`
      : "Search reached states: a fingerprint, a variable's value or an invariant; Enter for the next match";
    return [theme.fg("accent", asked), prompt.input.render(width)[0] ?? "", theme.fg(prompt.error ? "warning" : "muted", oneLine(prompt.status)), keys];
  }

  #graphCanvas(view: ModelView): string[] {
    const placed = this.#layoutOf(view);
    const w = widths[this.#detail] ?? 24, h = heights[this.#detail] ?? 4;
    const selectedBox = placed.boxes.find((box) => box.group.members.includes(this.#selected ?? ""));
    this.#settlePan(placed.width, placed.height, selectedBox === undefined ? undefined : { x: selectedBox.x, y: selectedBox.y, w, h });
    const { w: cw, h: ch } = this.#canvas;
    const [left, top] = this.#pan;
    const cells = Array.from({ length: ch }, () => Array.from({ length: cw }, () => ({ char: " ", role: "text" as ThemeColor })));
    const put = (x: number, y: number, text: string, role: ThemeColor): void => {
      const row = cells[y - top];
      if (row === undefined) return;
      // A cell a terminal column: a wide character takes two, the second left empty, and is blanked where the canvas cuts it.
      let column = Math.max(0, x - left);
      const clipped = sliceByColumn(oneLine(text), Math.max(0, left - x), cw - column);
      for (const { segment: char } of graphemes.segment(clipped)) {
        const span = visibleWidth(char);
        if (span === 0) continue;
        const cell = row[column], rest = span === 2 ? row[column + 1] : undefined;
        if (cell !== undefined) { cell.char = span === 2 && rest === undefined ? " " : char; cell.role = role; }
        if (rest !== undefined) { rest.char = cell === undefined ? " " : ""; rest.role = role; }
        column += span;
      }
    };
    for (const box of placed.boxes) {
      if (box.x + w <= left || box.x >= left + cw || box.y + h <= top || box.y >= top + ch) continue;
      const selected = box === selectedBox, breaking = box.group.violating > 0;
      const border: ThemeColor = selected ? "accent" : breaking ? "error" : "border";
      put(box.x, box.y, `┌${"─".repeat(w - 2)}┐`, border);
      put(box.x, box.y + h - 1, `└${"─".repeat(w - 2)}┘`, border);
      this.#boxLines(view, placed, box).slice(0, h - 2).forEach((line, at) => {
        put(box.x, box.y + 1 + at, "│", border);
        put(box.x + 1, box.y + 1 + at, fit(line.text, w - 2, true), selected && at === 0 ? "accent" : line.role);
        put(box.x + w - 1, box.y + 1 + at, "│", border);
      });
    }
    return cells.map((row) => this.#paint(row));
  }

  #boxLines(view: ModelView, placed: Layout, box: Box): Line[] {
    const { group } = box;
    const label = group.path.length === 0 ? group.members[0] ?? "" : group.path.map(([name, value]) => `${name} = ${value}`).join(" › ");
    const breaking = group.violating > 0;
    const lines: Line[] = [{ text: `${breaking ? "! " : ""}${box.number}. ${terminalText(label)}`, role: breaking ? "error" : "text" },
      { text: `${this.#count(group.members.length)} member${group.members.length === 1 ? "" : "s"}${breaking ? ` ! BREAK ${this.#count(group.violating)}` : ""}`,
        role: breaking ? "error" : "muted" }];
    if (this.#detail >= 1) {
      const out = view.edges.filter((edge) => edge.from === group.id).map((edge) =>
        `${terminalText(edge.action)}→${edge.to === group.id ? "self" : placed.byGroup.get(edge.to)?.number ?? "?"}${edge.count > 1 || view.partial ? ` ×${this.#count(edge.count)}` : ""}`);
      lines.push({ text: out.length === 0 ? "no edge out recorded" : out.join(", "), role: "muted" });
    }
    if (this.#detail >= 2) {
      const members = group.members.map((id) => this.#state(id)).filter((state) => state !== undefined);
      const others = view.variables.filter((name) => !view.projection.includes(name)).slice(0, 2);
      lines.push({ text: others.map((name) => {
        const values = [...new Set(members.map((state) => state.variables[name] ?? "(missing)"))];
        return values.length === 1 ? `${name} = ${values[0] ?? ""}` : `${name} ∈ {${values.join(", ")}}`;
      }).map(terminalText).join("; ") || "no other variable", role: "dim" });
    }
    return lines;
  }

  #traceCanvas(view: ModelView): string[] {
    const lines = view.trace.flatMap((step, at): Line[] => {
      const breaks = this.#state(step.fingerprint)?.breaks ?? [];
      const selected = step.fingerprint === this.#selected;
      return [{ text: `${selected ? "▶" : " "} ${at + 1}. ${step.fingerprint} <${terminalText(step.action)}>`, role: selected ? "accent" : "text" },
        { text: breaks.length > 0 ? `     ! BREAK ${breaks.join(", ")}` : "", role: "error" },
        { text: at < view.trace.length - 1 ? "     ↓" : "", role: "muted" }];
    });
    const at = view.trace.findIndex(({ fingerprint }) => fingerprint === this.#selected);
    this.#settlePan(Math.max(0, ...lines.map((line) => visibleWidth(oneLine(line.text)))), lines.length, at < 0 ? undefined : { x: 0, y: at * 3, w: 1, h: 2 });
    const { w, h } = this.#canvas;
    return Array.from({ length: h }, (_, row) => {
      const line = lines[row + this.#pan[1]];
      return line === undefined ? " ".repeat(w) : this.options.theme.fg(line.role, truncateToWidth(sliceByColumn(oneLine(line.text), this.#pan[0], w), w, "", true));
    });
  }

  /** Keeps the pan inside the drawing, and brings a newly selected state into view. */
  #settlePan(width: number, height: number, target: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } | undefined): void {
    const { w, h } = this.#canvas;
    let [x, y] = this.#pan;
    if (this.#reveal && target !== undefined) {
      if (target.x < x || target.w > w) x = target.x; else if (target.x + target.w > x + w) x = target.x + target.w - w;
      if (target.y < y || target.h > h) y = target.y; else if (target.y + target.h > y + h) y = target.y + target.h - h;
    }
    this.#reveal = false;
    this.#pan = [Math.max(0, Math.min(x, width - w)), Math.max(0, Math.min(y, height - h))];
  }

  #paint(row: readonly { readonly char: string; readonly role: ThemeColor }[]): string {
    let out = "", run = "", role: ThemeColor | undefined;
    for (const cell of row) {
      if (cell.role !== role && run !== "") { out += this.options.theme.fg(role ?? "text", run); run = ""; }
      role = cell.role;
      run += cell.char;
    }
    return out + (run === "" ? "" : this.options.theme.fg(role ?? "text", run));
  }

  /** The selected state in full: every variable as TLC printed it, what it breaks, and its group's edges. */
  #panel(view: ModelView, width: number, height: number): string[] {
    const { theme } = this.options;
    const id = this.#selected;
    const step = this.#trace === undefined ? undefined : view.trace.find(({ fingerprint }) => fingerprint === id);
    const state = this.#state(id);
    const valuation = step?.valuation ?? state?.valuation;
    if (id === undefined || valuation === undefined) return [theme.fg("muted", " No state selected.")];
    const breaks = state?.breaks ?? [];
    const group = this.#trace === undefined ? view.groups.find((each) => each.members.includes(id)) : undefined;
    const placed = this.#layoutOf(view);
    const lines: Line[] = [{ text: `State ${id}`, role: "accent" },
      breaks.length > 0 ? { text: `! BREAK ${breaks.join(", ")}`, role: "error" } : { text: "No violation reported for this state", role: "muted" },
      ...step === undefined ? [] : [{ text: `TLC trace step ${view.trace.indexOf(step) + 1}: ${terminalText(step.action)}`, role: "muted" as ThemeColor }],
      ...group === undefined ? [] : [{ text: `In group ${placed.byGroup.get(group.id)?.number ?? "?"}: ${this.#count(group.members.length)} members`, role: "muted" as ThemeColor }],
      { text: "", role: "text" }, { text: "Variables", role: "text" },
      ...assignments(valuation).map((text) => ({ text: `  ${text}`, role: "text" as ThemeColor }))];
    if (group !== undefined) {
      const out = view.edges.filter((edge) => edge.from === group.id);
      lines.push({ text: "", role: "text" }, { text: "Edges out of its group", role: "text" },
        ...out.length === 0 ? [{ text: "  none recorded", role: "muted" as ThemeColor }] : out.map((edge) => ({
          text: `  ${terminalText(edge.action)} → ${edge.to === group.id ? "itself" : placed.byGroup.get(edge.to)?.number ?? "?"} ×${this.#count(edge.count)}`,
          role: "muted" as ThemeColor })));
    }
    const rows = lines.flatMap((line) => wrapped(line.text, width - 1).map((text) => theme.fg(line.role, ` ${text}`)));
    this.#panelTop = Math.min(this.#panelTop, Math.max(0, rows.length - height));
    return rows.slice(this.#panelTop, this.#panelTop + height);
  }
}
