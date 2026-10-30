import { conservesCounts, partitionWeights } from "./verification/group-count-rule.js";
import type { ModelChart } from "./model-chart.js";
import type { ReachedGraph, TraceState } from "./model-graph.js";
import { stateVariables } from "./model-state.js";

export interface ViewRequest {
  readonly projection?: readonly string[];
  /** Fingerprints obtained by drilling into a reached group. */
  readonly members?: readonly string[];
  /** Project these groups as individual states; all other groups keep their edge multiplicities. */
  readonly expanded?: readonly string[];
  readonly search?: string;
  /** Also project the graph onto its chart (#761). */
  readonly chart?: boolean;
}
export interface ViewState {
  readonly fingerprint: string;
  readonly valuation: string;
  readonly variables: Readonly<Record<string, string>>;
  readonly breaks: readonly string[];
}
export interface ViewGroup {
  readonly id: string;
  readonly path: readonly (readonly [string, string])[];
  readonly members: string[];
  violating: number;
}
export interface ViewEdge { readonly from: string; readonly to: string; readonly action: string; count: number }
export interface ModelView {
  readonly workerPid: number;
  readonly partial: boolean;
  readonly projection: readonly string[];
  readonly variables: readonly string[];
  readonly states: readonly ViewState[];
  readonly groups: readonly ViewGroup[];
  readonly edges: readonly ViewEdge[];
  readonly boundary: number;
  readonly trace: readonly TraceState[];
  readonly violations: readonly string[];
  readonly matches: readonly string[];
  readonly plain: string;
  readonly ruleDefinitions?: Readonly<Record<string, string>>;
  readonly chart?: ModelChart;
}

/** A count as a partial graph allows reading it: a lower bound. */
export function boundedCount(partial: boolean, count: number): string {
  return `${partial ? "≥" : ""}${count}`;
}

export const PARTIAL_EXPLORATION = "Partial exploration: counts are at least these numbers";
export const GROUPED_MOVES = "Arrows between groups are possible moves, not one run.";
export const RULE_PREFIX = "Rule, from the model: ";
export const SELECTED_STATE = "Selected state";
export const COMPLETE_EXPLORATION = "Complete exploration; exact counts";
export const ZERO_REPORTS = "zero reports do not establish safety";
export const NO_BROKEN_RULE = "No broken rule reported for this state";

/** Display wording only; inspection retains the exact TLC values. */
export function stateCount(partial: boolean, count: number): string {
  return `${boundedCount(partial, count)} ${count === 1 ? "state" : "states"}`;
}
export const displayValue = (value: string): string => value.replace(/^"(.*)"$/su, "$1");
export function groupValues(entries: readonly (readonly [string, string])[]): string {
  return entries.map(([name, value]) => `${name}: ${displayValue(value)}`).join(" · ");
}
export function brokenRules(names: readonly string[]): string { return `⚠ breaks ${names.join(", ")}`; }
export function ruleText(names: readonly string[], definitions: Readonly<Record<string, string>> = {}): string[] {
  return [...new Set(names)].flatMap(name => Object.hasOwn(definitions, name) ? [`${RULE_PREFIX}${definitions[name]}`] : []);
}
export function groupLabel(view: Pick<ModelView, "states">, group: ViewGroup): string {
  return groupValues(group.path.length === 0 ? Object.entries(view.states.find(s => s.fingerprint === group.members[0])?.variables ?? {}) : group.path);
}
export function groupRules(view: Pick<ModelView, "states">, group: ViewGroup): string[] {
  return [...new Set(view.states.filter(s => group.members.includes(s.fingerprint)).flatMap(s => s.breaks))];
}

export function defaultProjection(states: readonly ViewState[], header: string): string[] {
  const names = [...new Set(states.flatMap(s => Object.keys(s.variables)))].sort();
  const declared = /^\s*\(?\*?\s*@view groupBy:\s*([\w ,]+)/mu.exec(header)?.[1]?.split(",").map(s => s.trim()).filter(Boolean);
  if (declared !== undefined && declared.length > 0 && declared.length <= 2 && new Set(declared).size === declared.length && declared.every(k => names.includes(k))) return declared;
  if (names.includes("pc")) return ["pc"];
  const candidates = names.map(name => ({ name, count: new Set(states.map(s => s.variables[name])).size }))
    .filter(c => c.count >= 2 && c.count <= 16).sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  return candidates[0] === undefined ? [] : [candidates[0].name];
}

/** Ordered, wrapping navigation over concrete violating states, never guessed from topology. */
export function adjacentViolation(view: ModelView, current: string | undefined, direction: 1 | -1): string | undefined {
  const ids = view.violations;
  if (ids.length === 0) return undefined;
  const index = current === undefined ? -1 : ids.indexOf(current);
  return ids[index < 0 ? (direction === 1 ? 0 : ids.length - 1) : (index + direction + ids.length) % ids.length];
}

export function buildModelView(graph: ReachedGraph, reports: { readonly trace: readonly TraceState[]; readonly violations: Readonly<Record<string, readonly string[]>>; readonly ruleDefinitions?: Readonly<Record<string, string>> },
  partial: boolean, header: string, request: ViewRequest): ModelView {
  const ids = new Set(graph.states.map(s => s.fingerprint));
  if ([...reports.trace.map(s => s.fingerprint), ...Object.values(reports.violations).flat()].some(id => !ids.has(id))) {
    throw new Error("TLC report state missing from captured graph");
  }
  const all = graph.states.map(s => ({ ...s, variables: Object.fromEntries(stateVariables(s.valuation.split(/\r?\n/u))),
    breaks: Object.entries(reports.violations).filter(([, ids]) => ids.includes(s.fingerprint)).map(([name]) => name) }));
  const variables = [...new Set(all.flatMap(s => Object.keys(s.variables)))].sort();
  const projection = request.projection ?? defaultProjection(all, header);
  if (projection.length > 2 || new Set(projection).size !== projection.length || projection.some(k => !variables.includes(k))) throw new Error("Choose up to two distinct existing variables");
  const scope = request.members === undefined ? undefined : new Set(request.members);
  if (scope !== undefined && [...scope].some(id => !ids.has(id))) throw new Error("Unknown drill member");
  const states = all.filter(s => scope === undefined || scope.has(s.fingerprint));
  const groups = new Map<string, ViewGroup>(), membership = new Map<string, string>();
  const expanded = new Set(request.expanded);
  for (const state of states) {
    let path = projection.map(k => [k, state.variables[k] ?? "(missing)"] as const);
    let id = projection.length === 0 ? state.fingerprint : JSON.stringify(path);
    if (expanded.has(id)) { id = state.fingerprint; path = []; }
    let group = groups.get(id);
    if (group === undefined) { group = { id, path, members: [], violating: 0 }; groups.set(id, group); }
    group.members.push(state.fingerprint);

    membership.set(state.fingerprint, id);
  }
  const bad = new Set(states.filter(s => s.breaks.length > 0).map(s => s.fingerprint));
  for (const group of groups.values()) {
    const counts = partitionWeights(group.members.map(id => bad.has(id)), group.members.map(() => 1));
    group.violating = counts.inside;
    if (counts.inside + counts.outside !== group.members.length) throw new Error("Member count not conserved");
  }
  const { edges, boundary, internal } = projectEdges(graph, membership);
  if (!conservesCounts(states.map(() => 1), states.map(s => s.breaks.length > 0 ? 1 : 0), internal.map(() => 1),
    [...groups.values()].map(g => g.members.length), [...groups.values()].map(g => g.violating), edges.map(e => e.count))) {
    throw new Error("Projection did not conserve members, violations and edge multiplicities");
  }
  const query = request.search?.toLocaleLowerCase() ?? "";
  const base = { workerPid: process.pid, ruleDefinitions: reports.ruleDefinitions ?? {}, partial, projection, variables, states, groups: [...groups.values()], edges, boundary,
    trace: reports.trace, violations: states.filter(s => s.breaks.length > 0).map(s => s.fingerprint),
    matches: query === "" ? [] : states.filter(s => `${s.fingerprint}\n${s.valuation}\n${s.breaks.join(" ")}`.toLocaleLowerCase().includes(query)).map(s => s.fingerprint) };
  return { ...base, plain: renderModelView(base) };
}

function projectEdges(graph: ReachedGraph, membership: ReadonlyMap<string, string>): { edges: ViewEdge[]; boundary: number; internal: ReachedGraph["edges"] } {
  const edges = new Map<string, ViewEdge>();
  const internal: ReachedGraph["edges"] = [];
  let boundary = 0;
  for (const edge of graph.edges) {
    const from = membership.get(edge.from), to = membership.get(edge.to);
    if (from === undefined || to === undefined) { if (from !== undefined || to !== undefined) boundary++; continue; }
    internal.push(edge);
    const key = JSON.stringify([from, to, edge.action]);
    const found = edges.get(key);
    if (found === undefined) edges.set(key, { from, to, action: edge.action, count: 1 });
    else found.count++;
  }
  return { edges: [...edges.values()], boundary, internal };
}

/** No layout, terminal controls or claim that a quotient path is an execution. */
export function renderModelView(view: Omit<ModelView, "plain">): string {
  const count = (n: number): string => boundedCount(view.partial, n);
  const groupName = (id: string): string => `Group ${view.groups.findIndex(group => group.id === id) + 1}`;
  return [view.partial ? PARTIAL_EXPLORATION : COMPLETE_EXPLORATION,
    `Reached ${count(view.states.length)}; reported violating ${count(view.violations.length)} (${ZERO_REPORTS})`,
    `${GROUPED_MOVES} Only TLC's concrete trace is an execution.`,
    ...ruleText(view.states.flatMap(state => state.breaks), view.ruleDefinitions),
    ...view.groups.map(g => `${groupName(g.id)} · ${groupLabel(view, g)}: ${stateCount(view.partial, g.members.length)}${g.violating > 0 ? ` · ${brokenRules(groupRules(view, g))} · ${stateCount(view.partial, g.violating)}` : ""}`),
    ...view.edges.map(e => `${groupName(e.from)} -> ${groupName(e.to)} [${e.action}] x${count(e.count)}`),
    `Boundary edges: ${count(view.boundary)}`, "Full reached states:",
    ...view.states.map(s => `Reached state${s.breaks.length > 0 ? ` · ${brokenRules(s.breaks)}` : ""}\nTLC id ${s.fingerprint}\n${ruleText(s.breaks, view.ruleDefinitions).join("\n")}\n${s.valuation}`),
    "TLC concrete trace (not regrouped or filtered):", ...view.trace.map((s, i) => `${i + 1}. ${s.fingerprint} <${s.action}>\n${s.valuation}`),
    `Search matches: ${view.matches.join(", ")}`].join("\n");
}
