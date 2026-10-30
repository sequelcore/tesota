import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ReachedGraph, TraceState } from "./model-graph.js";
import { stateValues, stateVariables } from "./model-state.js";
import { boundedCount, brokenRules, defaultProjection, groupValues, stateCount } from "./model-view.js";

/**
 * The chart (#761): TLC's reached graph projected onto a few states in the
 * user's words, with TLC's trace numbered on it. The words come from a reading
 * the agent writes beside the model, `<Model>.chart.ts`; without one, states
 * are grouped by the model's control variable. The projection only regroups
 * TLC's states and steps: every reached state is in one chart state, and
 * every step of the trace is drawn. Labels are a reading, never evidence.
 */

/** More chart states than this open on TLC's graph when no rule broke, and fold off a breaking path. */
export const CHART_STATES = 50;

/** The reading's format, as Tesota names it to an agent whose model has none. */
export const READING_FORMAT: string = [
  "// <Model>.chart.ts, beside the model: how /graph reads TLC's states, in the user's words.",
  "// v holds a TLC state's variables: numbers, strings and booleans; <<tuples>> and {sets} as arrays; records and functions as objects.",
  "export function state(v) { return \"<what the system shows in this state>\"; }",
  "// Optional: a label for each step, and a box around related states.",
  "export function step(action, before, after) { return \"<what this step does>\"; }",
  "export function group(v) { return \"<the part of the design this state is in>\"; }",
].join("\n");

type Values = Readonly<Record<string, unknown>>;
/** A loaded reading: the file's name and the functions it exports. */
export interface ChartReading {
  readonly file: string;
  readonly state: (v: Values) => unknown;
  readonly step?: (action: string, before: Values, after: Values) => unknown;
  readonly group?: (v: Values) => unknown;
}
/** A reading that could not be loaded, and why; `untrusted` when it wasn't run because the operator hasn't trusted it. */
export interface ChartFailure { readonly file: string; readonly reason: string; readonly untrusted?: true }

/**
 * Whether the operator trusts the reading `file` of the project at `root` as
 * it is now (`hash`). A reading is the project's own code, so it runs only
 * once trusted, as a project's hooks do; the engine's trust store answers.
 */
export type ReadingTrust = (root: string, file: string, hash: string) => boolean;

export interface ChartNode {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly members: string[];
  readonly breaks: string[];
  readonly start: boolean;
}
/** A move between chart states; a path edge carries the numbers of the trace's steps it draws. */
export interface ChartEdge { readonly id: string; readonly from: string; readonly to: string; label: string; count: number; readonly steps: number[] }
export interface ChartStep { readonly number: number; readonly from: string; readonly to: string; readonly label: string; readonly action: string; readonly fingerprint: string }
export interface ModelChart {
  /** The reading the labels came from; absent when states are grouped by a variable. */
  readonly reading?: string;
  /** Where the labels came from, or why the reading wasn't used and how to write one. */
  readonly note: string;
  readonly projection: readonly string[];
  readonly partial: boolean;
  readonly nodes: readonly ChartNode[];
  readonly edges: readonly ChartEdge[];
  readonly path: readonly ChartStep[];
  /** Reached states left out because the chart is past its budget and they are off the breaking path. */
  readonly folded: number;
  readonly opens: "chart" | "graph";
}

/** The reading's path beside a model, from the project root. */
export function readingPath(model: string): string {
  return join(dirname(model), `${basename(model).replace(/\.(tla|qnt)$/u, "")}.chart.ts`).replaceAll("\\", "/");
}

/** The hash a reading's trust is given to: its bytes as written, so any change asks again. */
export function readingHash(source: Uint8Array | string): string {
  return createHash("sha256").update(source).digest("hex");
}

/** The project a capture was bound to, where its reading lives, else the capture's folder; and its model. */
export function captureReading(binding: { readonly root?: string; readonly model?: string } | undefined, manifest: string): { root: string; model: string } {
  return { root: binding?.root ?? dirname(manifest), model: binding?.model ?? basename(manifest) };
}

/** The reading beside a capture's model as it is now, for the shell to ask about; undefined when there is none. */
export async function manifestReading(manifest: string): Promise<{ root: string; file: string; hash: string } | undefined> {
  try {
    if ((await stat(manifest)).size > 32 * 1024 * 1024) return undefined;
    const data = JSON.parse(await readFile(manifest, "utf8")) as { binding?: { root?: string; model?: string } };
    const { root, model } = captureReading(data.binding, manifest);
    const file = readingPath(model);
    return { root, file, hash: readingHash(await readFile(resolve(root, file))) };
  } catch {
    return undefined;
  }
}

type Transpiler = new (options: { loader: "ts" }) => { transformSync(code: string): string };

/**
 * The reading's own bytes as a module, so what runs is exactly what was
 * trusted. A relative import has no file to resolve from and fails, so the
 * trust never covers code beside the reading.
 */
async function sourceModule(source: string): Promise<Record<string, unknown>> {
  const bun = (globalThis as { Bun?: { Transpiler: Transpiler } }).Bun;
  if (bun === undefined) throw new Error("readings run only in Tesota's own runtime");
  const code = new bun.Transpiler({ loader: "ts" }).transformSync(source);
  return await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as Record<string, unknown>;
}

/**
 * Loads the reading beside a model, only if the operator trusts it as it is
 * now. It runs in the disposable view process, never in the shell; the bytes
 * hashed are the bytes run.
 */
export async function loadReading(root: string, model: string, trusted: ReadingTrust): Promise<ChartReading | ChartFailure> {
  const file = readingPath(model), path = resolve(root, file);
  if (!existsSync(path)) return { file, reason: `${file} does not exist` };
  let module: Record<string, unknown>;
  try {
    const source = await readFile(path);
    if (!trusted(root, file, readingHash(source))) {
      return { file, untrusted: true, reason: `${file} wasn't run: this project's chart readings aren't trusted. ` +
        "Open /graph in Tesota's shell and choose Trust it to run it; a changed reading asks again" };
    }
    module = await sourceModule(source.toString("utf8"));
  } catch (error) {
    return { file, reason: `${file} could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  const { state, step, group } = module;
  if (typeof state !== "function") return { file, reason: `${file} exports no state(v) function` };
  if ((step !== undefined && typeof step !== "function") || (group !== undefined && typeof group !== "function")) {
    return { file, reason: `${file} exports step or group as something other than a function` };
  }
  return { file, state: state as ChartReading["state"],
    ...typeof step === "function" ? { step: step as NonNullable<ChartReading["step"]> } : {},
    ...typeof group === "function" ? { group: group as NonNullable<ChartReading["group"]> } : {} };
}

interface Labels { state(id: string): string; group(id: string): string; step(action: string, from: string, to: string): string }

const actionName = (action: string): string => action.replace(/ line \d+[\s\S]*$/u, "");

/** A label the reading returned, on one line; anything but non-empty text is no label. */
function label(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${what} returned no label`);
  const text = value.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

function readingLabels(reading: ChartReading, valuations: ReadonlyMap<string, string>): Labels {
  const cache = new Map<string, Values>();
  const values = (id: string): Values => {
    const found = cache.get(id) ?? stateValues(valuations.get(id) ?? "");
    cache.set(id, found);
    return found;
  };
  const call = (what: string, at: string, run: () => unknown): string => {
    try { return label(run(), what); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.startsWith(what) ? `${reading.file}: ${message} for TLC state ${at}` : `${reading.file}: ${what} failed on TLC state ${at}: ${message}`);
    }
  };
  const { state, step, group } = reading;
  return {
    state: (id) => call("state()", id, () => state(values(id))),
    group: (id) => group === undefined ? "" : call("group()", id, () => group(values(id))),
    step: (action, from, to) => step === undefined ? action : call("step()", to, () => step(action, values(from), values(to))),
  };
}

function controlLabels(projection: readonly string[], variables: ReadonlyMap<string, Readonly<Record<string, string>>>): Labels {
  return {
    state: (id) => {
      const all = variables.get(id) ?? {};
      return groupValues(projection.length === 0 ? Object.entries(all) : projection.map((name) => [name, all[name] ?? "(missing)"]));
    },
    group: () => "",
    step: (action) => action,
  };
}

export function buildChart(graph: ReachedGraph, reports: { readonly trace: readonly TraceState[]; readonly violations: Readonly<Record<string, readonly string[]>> },
  partial: boolean, header: string, reading: ChartReading | ChartFailure): ModelChart {
  const valuations = new Map(graph.states.map((state) => [state.fingerprint, state.valuation]));
  const variables = new Map(graph.states.map((state) => [state.fingerprint, Object.fromEntries(stateVariables(state.valuation.split(/\r?\n/u)))]));
  const breaks = (id: string): string[] => Object.entries(reports.violations).filter(([, ids]) => ids.includes(id)).map(([name]) => name);
  const order = [...new Set([...reports.trace.map((step) => step.fingerprint), ...graph.states.map((state) => state.fingerprint)])];
  let projection: string[] = [];
  let built: ReturnType<typeof project>;
  let note: string;
  let read = false;
  try {
    if (!("state" in reading)) throw new Error(reading.reason);
    built = project(order, readingLabels(reading, valuations), graph, reports, breaks);
    note = `Labels from ${reading.file}: the agent's reading of TLC's graph, not evidence.`;
    read = true;
  } catch (error) {
    projection = defaultProjection(graph.states.map((state) => ({ ...state, variables: variables.get(state.fingerprint) ?? {}, breaks: [] })), header);
    built = project(order, controlLabels(projection, variables), graph, reports, breaks);
    note = `${error instanceof Error ? error.message : String(error)}. Grouped by ${projection.join(" › ") || "each state"}.` + ("untrusted" in reading ? ""
      : ` Write ${reading.file} to label states in your words: export state(v), and optionally step(action, before, after) and group(v), each returning a label.`);
  }
  const { nodes, edges, path } = built;
  let kept = nodes;
  if (nodes.length > CHART_STATES && path.length > 0) {
    const onPath = new Set(path.flatMap((step) => [step.from, step.to]));
    kept = nodes.filter((node) => onPath.has(node.id));
  }
  const ids = new Set(kept.map((node) => node.id));
  return { ...read ? { reading: reading.file } : {}, note, projection, partial,
    nodes: kept, edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), path,
    folded: nodes.filter((node) => !ids.has(node.id)).reduce((sum, node) => sum + node.members.length, 0),
    opens: path.length > 0 || nodes.length <= CHART_STATES ? "chart" : "graph" };
}

function project(order: readonly string[], labels: Labels, graph: ReachedGraph, reports: { readonly trace: readonly TraceState[] },
  breaks: (id: string) => string[]): { nodes: ChartNode[]; edges: ChartEdge[]; path: ChartStep[] } {
  const byKey = new Map<string, ChartNode>(), nodeOf = new Map<string, ChartNode>();
  for (const id of order) {
    const group = labels.group(id), key = JSON.stringify([group, labels.state(id)]);
    let node = byKey.get(key);
    if (node === undefined) {
      node = { id: `n${byKey.size + 1}`, label: labels.state(id), group, members: [], breaks: [], start: reports.trace[0]?.fingerprint === id };
      byKey.set(key, node);
    }
    node.members.push(id);
    for (const rule of breaks(id)) if (!node.breaks.includes(rule)) node.breaks.push(rule);
    nodeOf.set(id, node);
  }
  const at = (id: string): string => nodeOf.get(id)?.id ?? "";
  const path = reports.trace.slice(1).map((step, index): ChartStep => {
    const before = reports.trace[index]?.fingerprint ?? "", action = actionName(step.action);
    return { number: index + 1, from: at(before), to: at(step.fingerprint), label: labels.step(action, before, step.fingerprint), action, fingerprint: step.fingerprint };
  });
  const drawn = new Map<string, ChartEdge>();
  for (const step of path) {
    const key = JSON.stringify([step.from, step.to]);
    const edge = drawn.get(key) ?? { id: `p${drawn.size + 1}`, from: step.from, to: step.to, label: "", count: 0, steps: [] };
    edge.steps.push(step.number);
    edge.count++;
    edge.label = edge.steps.map((number) => `${number}. ${path[number - 1]?.label ?? ""}`).join("\n");
    drawn.set(key, edge);
  }
  const moves = new Map<string, { from: string; to: string; labels: Map<string, number> }>();
  for (const edge of graph.edges) {
    const from = at(edge.from), to = at(edge.to);
    if (from === to) continue;
    const text = labels.step(actionName(edge.action), edge.from, edge.to);
    if (path.some((step) => step.from === from && step.to === to && step.label === text)) continue;
    const key = JSON.stringify([from, to]);
    const move = moves.get(key) ?? { from, to, labels: new Map<string, number>() };
    move.labels.set(text, (move.labels.get(text) ?? 0) + 1);
    moves.set(key, move);
  }
  const others = [...moves.values()].map((move, index): ChartEdge => {
    const texts = [...move.labels.keys()];
    return { id: `e${index + 1}`, from: move.from, to: move.to, steps: [], count: [...move.labels.values()].reduce((sum, n) => sum + n, 0),
      label: texts.length <= 2 ? texts.join("\n") : `${texts[0] ?? ""}\nand ${texts.length - 1} other steps` };
  });
  return { nodes: [...byKey.values()], edges: [...drawn.values(), ...others], path };
}

/** Text for Mermaid: quoted, with every character Mermaid reads as syntax written as an entity. */
const quoted = (text: string): string => `"${text.replace(/#/gu, "#35;").replace(/"/gu, "#quot;").replace(/</gu, "#lt;").replace(/>/gu, "#gt;")
  .replace(/`/gu, "#96;").split("\n").join("<br>")}"`;

/** The chart as a Mermaid flowchart: the trace's steps solid and numbered, other possible moves dotted. */
export function chartMermaid(chart: ModelChart, direction: "LR" | "TB"): string {
  const nodeLine = (node: ChartNode, indent: string): string =>
    `${indent}${node.id}(${quoted([node.label, ...node.start ? ["(start)"] : [], ...node.breaks.length > 0 ? [brokenRules(node.breaks)] : []].join("\n"))})`;
  const groups = [...new Set(chart.nodes.map((node) => node.group))];
  // Classes only: the page styles them from its own tokens, with no inline style for its policy to refuse.
  return [`flowchart ${direction}`,
    ...groups.flatMap((group, index) => group === "" ? chart.nodes.filter((node) => node.group === "").map((node) => nodeLine(node, "  "))
      : [`  subgraph c${index + 1} [${quoted(group)}]`, ...chart.nodes.filter((node) => node.group === group).map((node) => nodeLine(node, "    ")), "  end"]),
    ...chart.edges.map((edge) => `  ${edge.from} ${edge.id}@${edge.steps.length > 0 ? "-->" : "-.->"}|${quoted(edge.label)}| ${edge.to}`),
    ...chart.nodes.filter((node) => node.breaks.length > 0).map((node) => `  class ${node.id} broken`),
    ...chart.nodes.filter((node) => node.start).map((node) => `  class ${node.id} start`)].join("\n");
}

/** A line of the chart as text; `state` is the TLC state it stands for, to inspect. */
export interface ChartLine { readonly text: string; readonly kind: "note" | "heading" | "state" | "broken" | "step" | "move"; readonly state?: string }

/** The chart as text, for the terminal viewer and `--plain`. */
export function chartLines(chart: ModelChart): ChartLine[] {
  const number = new Map(chart.nodes.map((node, index) => [node.id, index + 1]));
  const others = chart.edges.filter((edge) => edge.steps.length === 0);
  return [{ text: `Chart: ${chart.note}`, kind: "note" }, { text: "States", kind: "heading" },
    ...chart.nodes.map((node, index): ChartLine => ({ kind: node.breaks.length > 0 ? "broken" : "state", ...node.members[0] === undefined ? {} : { state: node.members[0] },
      text: `${index + 1}. ${node.group === "" ? "" : `${node.group} › `}${node.label}${node.start ? " · start" : ""} · ${stateCount(chart.partial, node.members.length)}${
        node.breaks.length > 0 ? ` · ${brokenRules(node.breaks)}` : ""}` })),
    ...chart.path.length === 0 ? [] : [{ text: `The breaking path: TLC's trace, ${chart.path.length} ${chart.path.length === 1 ? "step" : "steps"}`, kind: "heading" as const },
      ...chart.path.map((step): ChartLine => ({ kind: "step", state: step.fingerprint,
        text: `${step.number}. ${step.label} (${number.get(step.from) ?? "?"} → ${number.get(step.to) ?? "?"}; TLC: ${step.action})` }))],
    ...others.length === 0 ? [] : [{ text: "Other possible moves", kind: "heading" as const },
      ...others.map((edge): ChartLine => ({ kind: "move",
        text: `${number.get(edge.from) ?? "?"} → ${number.get(edge.to) ?? "?"}: ${edge.label.split("\n").join("; ")} ×${boundedCount(chart.partial, edge.count)}` }))],
    ...chart.folded === 0 ? [] : [{ text: `${stateCount(chart.partial, chart.folded)} off the breaking path are folded; TLC's graph shows them.`, kind: "note" as const }]];
}
