import cytoscape from "cytoscape";
import { NO_BROKEN_RULE, displayValue, boundedCount, stateCount, groupValues, groupLabel, groupRules, brokenRules, ruleText, RULE_PREFIX, SELECTED_STATE, PARTIAL_EXPLORATION, buildModelView, type ViewGroup } from "./model-view.js";
import { stateVariables } from "./model-state.js";
import type { HtmlModel } from "./model-html.js";

const data = JSON.parse(document.querySelector("#model-data")?.textContent ?? "") as HtmlModel;
const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let view = data.view;
const expanded = new Set<string>();
let traceVisible = false;
const colors = (): { bg: string; fg: string; error: string; accent: string; border: string } => {
  const style = getComputedStyle(document.documentElement);
  return { bg: style.getPropertyValue("--panel").trim(), fg: style.getPropertyValue("--fg").trim(),
    error: style.getPropertyValue("--error").trim(), accent: style.getPropertyValue("--accent").trim(),
    border: style.getPropertyValue("--border").trim() };
};
const cy = cytoscape({ container: get("graph"), elements: [], layout: { name: "grid" }, minZoom: .05, maxZoom: 5 });
const count = (n: number): string => boundedCount(view.partial, n);
const states = (n: number): string => stateCount(view.partial, n);
const values = groupValues;
const stateLabel = (g: ViewGroup, index: number): string => g.members.length > 1 ? `state ${index + 1} of ${g.members.length}` : "state";
const label = (g: ViewGroup): string => groupLabel(view, g);
const rules = (g: ViewGroup): string => groupRules(view, g).join(", ");
// A starting state is known only when TLC supplied a trace; topology is not evidence of initialization.
const initial = (g: ViewGroup): boolean => view.trace[0] !== undefined && g.members.includes(view.trace[0].fingerprint);
function button(text: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button"); element.textContent = text; element.onclick = action; return element;
}
function paragraph(text: string, className = ""): HTMLParagraphElement {
  const p = document.createElement("p"); p.textContent = text; p.className = className; return p;
}
function appendRules(parent: HTMLElement, names: readonly string[]): void {
  for (const text of ruleText(names, data.reports.ruleDefinitions)) {
    const p = paragraph(RULE_PREFIX, "rule-definition"), code = document.createElement("code");
    code.textContent = text.slice(RULE_PREFIX.length); p.append(code); parent.append(p);
  }
}
function variables(entries: readonly (readonly [string, string])[]): HTMLDListElement {
  const dl = document.createElement("dl");
  for (const [k, v] of entries) {
    const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.append(dt, dd);
  }
  return dl;
}
function openPanel(): void {
  get("panel").hidden = false; document.body.classList.remove("panel-collapsed");
  get("panel-toggle").textContent = "Hide panel"; get("panel-toggle").setAttribute("aria-expanded", "true"); cy.resize();
}
function details(id: string): void {
  const state = view.states.find(s => s.fingerprint === id);
  if (state === undefined) return;
  openPanel();
  const panel = get("details"); panel.replaceChildren();
  const title = document.createElement("h2"); title.textContent = SELECTED_STATE;
  panel.append(title, paragraph(state.breaks.length ? brokenRules(state.breaks) : NO_BROKEN_RULE, state.breaks.length ? "break" : ""),
  );
  appendRules(panel, state.breaks);
  panel.append(variables(Object.entries(state.variables)), paragraph(`TLC id ${id}`, "secondary"));
}
function groupDetails(group: ViewGroup): void {
  openPanel(); const panel = get("details"); panel.replaceChildren();
  const title = document.createElement("h2"); title.textContent = "Selected group";
  panel.append(title, variables(group.path), paragraph(states(group.members.length)));
  if (group.violating) panel.append(paragraph(`${brokenRules(groupRules(view, group))} · ${states(group.violating)}`, "break"));
  appendRules(panel, rules(group).split(", "));
  panel.append(button(`Show its ${group.members.length} ${group.members.length === 1 ? "state" : "states"}`, () => { expanded.add(group.id); render(); }));
}
function elements(): cytoscape.ElementDefinition[] {
  const nodeIds = new Map<string, string>();
  const nodes: cytoscape.ElementDefinition[] = [];
  for (const [i, group] of view.groups.entries()) {
    const gid = `g${i}`;
    if (!expanded.has(group.id)) nodeIds.set(group.id, gid);
    const text = `${initial(group) ? "start\n" : ""}${label(group)}\n${states(group.members.length)}${group.violating ? `\n${brokenRules(groupRules(view, group))} · ${states(group.violating)}` : ""}`;
    nodes.push({ data: { id: gid, label: text, members: group.members, group: group.id }, classes: `${group.violating ? "break" : ""} ${initial(group) ? "start" : ""}` });
    for (const [index, id] of group.members.entries()) {
      if (!expanded.has(group.id)) continue;
      nodeIds.set(id, `s${id}`);
      const state = view.states.find(s => s.fingerprint === id);
      nodes.push({ data: { id: `s${id}`, parent: gid, label: `${id === view.trace[0]?.fingerprint ? "start\n" : ""}${group.members.length > 1 ? `${stateLabel(group, index)}\n` : ""}${label(group)}${state?.breaks.length ? `\n${brokenRules(state.breaks)}` : ""}`, members: [id], group: group.id }, classes: `${state?.breaks.length ? "break" : ""} ${id === view.trace[0]?.fingerprint ? "start" : ""}` });
    }
  }
  // The model owns mixed expansion too: folded groups retain aggregated multiplicities.
  const displayed = expanded.size === 0 ? view : buildModelView(data.graph, data.reports, view.partial, data.header,
    { projection: view.projection, expanded: [...expanded] });
  const edges = displayed.edges.map((e, i) => ({ data: { id: `e${i}`, source: nodeIds.get(e.from), target: nodeIds.get(e.to), label: `${e.action}${e.count > 1 ? ` ×${count(e.count)}` : ""}`, action: e.action } }));
  return [...nodes, ...edges];
}
function styleGraph(): void {
  const c = colors();
  cy.style().selector("node").style({ shape: "round-rectangle", "background-color": c.bg, color: c.fg, label: "data(label)", "text-wrap": "wrap", "text-max-width": "260px", width: "label", height: "label", padding: "12px", "text-valign": "center", "text-halign": "center", "font-family": "system-ui", "font-size": 14, "border-color": c.border, "border-width": 1 })
    .selector("edge").style({ label: "data(label)", color: c.fg, "line-color": c.fg, "line-opacity": .45, "target-arrow-color": c.fg, "arrow-scale": 1.2, "target-arrow-shape": "triangle", "font-family": "system-ui", "curve-style": "bezier", "control-point-step-size": 80, "font-size": 12, "text-background-color": c.bg, "text-background-opacity": 1, "text-background-padding": "3px", "text-background-shape": "roundrectangle" })
    .selector(".start").style({ "border-width": 3 })
    .selector(".trace").style({ "border-color": c.accent, "border-width": 5, "line-color": c.accent, "line-opacity": 1, "target-arrow-color": c.accent, width: 5 })
    .selector("node.trace").style({ width: "label", "underlay-color": c.accent, "underlay-opacity": .15, "underlay-padding": 6 })
    .selector(".match").style({ "border-color": c.accent, "border-width": 3, "border-style": "dashed", "line-color": c.accent, "line-opacity": 1, "line-style": "dashed" })
    .selector("edge.match").style({ width: 5 })
    // Error identity wins over trace/search; the trace remains visible as an accent underlay.
    .selector(".break").style({ color: c.error, "border-color": c.error, "border-width": 2, "background-color": c.error, "background-opacity": .12 })
    .selector(".start.break").style({ "border-width": 3 })
    .selector(":selected").style({ "overlay-color": c.accent, "overlay-opacity": .15, "overlay-padding": 6 })
    // Expanded members follow execution depth, not group clusters. Keep structural parents
    // for membership/search, but draw no enclosing box that could imply false membership.
    .selector(":parent").style({ label: "", "background-opacity": 0, "border-width": 0, "overlay-opacity": 0, "underlay-opacity": 0, padding: "0px", events: "no" }).update();
}
function search(): void {
  const query = get<HTMLInputElement>("search").value.toLocaleLowerCase();
  const found = buildModelView(data.graph, data.reports, view.partial, data.header, { projection: view.projection, search: query });
  cy.elements().removeClass("match");
  if (query === "") return;
  const ids = new Set(found.matches);
  cy.nodes().filter(n => (n.data("members") as string[] | undefined)?.some(id => ids.has(id)) ?? false).addClass("match");
  cy.edges().filter(e => String(e.data("action")).toLocaleLowerCase().includes(query)).addClass("match");
}
function highlightTrace(): void {
  cy.elements().removeClass("trace");
  if (!traceVisible) return;
  for (const [i, step] of view.trace.entries()) {
    cy.nodes().filter(n => (n.data("members") as string[] | undefined)?.includes(step.fingerprint) ?? false).addClass("trace");
    const previous = view.trace[i - 1];
    if (previous !== undefined) cy.edges().filter(e => e.source().id() === `s${previous.fingerprint}` && e.target().id() === `s${step.fingerprint}` && (step.action === e.data("action") || step.action.startsWith(`${String(e.data("action"))} line `))).forEach(e => {
      e.addClass("trace"); e.data("label", `${String(e.data("label"))} · ${i} → ${i + 1}`);
    });
  }
}
function summary(): void {
  const bad = view.states.find(s => s.breaks.length > 0);
  const end = view.trace.at(-1);
  const traceBad = view.states.find(s => s.fingerprint === end?.fingerprint && s.breaks.length > 0);
  const example = traceBad ?? bad;
  get("title").textContent = example === undefined ? "TLC reported no broken rule in the states it reached"
    : `TLC found a state that breaks ${example.breaks.join(", ")}${traceBad === undefined ? "" : ` in ${view.trace.length - 1} ${view.trace.length === 2 ? "step" : "steps"} from the start`}`;
  get("summary-rules").replaceChildren();
  appendRules(get("summary-rules"), example?.breaks ?? []);
  get("summary-values").textContent = example === undefined ? (view.partial ? "exploration was partial, so this is not proof of safety" : "") : values(Object.entries(example.variables));
  get("caveats").textContent = view.partial ? `${PARTIAL_EXPLORATION}.` : "";
  get("counts").textContent = `${data.model} · reached ${states(view.states.length)} · reported violating ${states(view.violations.length)}`;
}
function layoutGraph(): void {
  const leaves = cy.nodes().filter(n => n.isChildless());
  let roots = leaves.filter(n => n.hasClass("start")).map(n => n.id());
  // A layout seed is not evidence of an initial state. Without a trace, add no start tag.
  if (roots.length === 0) roots = leaves.roots().map(n => n.id());
  if (roots.length === 0) roots = leaves.slice(0, 1).map(n => n.id());
  const width = Math.max(1, ...leaves.map(n => n.outerWidth())) + 64;
  const height = Math.max(1, ...leaves.map(n => n.outerHeight())) + 64;
  const unit = Math.max(width, height);
  const graph = get("graph");
  let horizontal: boolean | undefined;
  cy.layout({ name: "breadthfirst", directed: true, roots, animate: false, fit: false,
    boundingBox: { x1: 0, y1: 0, w: 1, h: 1 }, padding: 0, spacingFactor: 1, avoidOverlap: true,
    transform: (_node, position) => {
      // Breadthfirst uses the widest label for BOTH axes. Compact each axis independently,
      // keeping its depth/order, and pick the orientation that fits this canvas best.
      if (horizontal === undefined) {
        const depths = leaves.map(n => (n.scratch("breadthfirst") as { depth: number }).depth);
        const levels = Math.max(...depths) + 1;
        const breadth = Math.max(...depths.map(d => depths.filter(value => value === d).length));
        const verticalFit = Math.min(graph.clientWidth / (breadth * width), graph.clientHeight / (levels * height));
        const horizontalFit = Math.min(graph.clientWidth / (levels * width), graph.clientHeight / (breadth * height));
        horizontal = horizontalFit > verticalFit;
      }
      // The small bounding box makes breadthfirst's minimum node distance the spacing unit.
      const distance = unit - 64;
      return horizontal ? { x: position.y * width / distance, y: position.x * height / distance }
        : { x: position.x * width / distance, y: position.y * height / distance };
    },
  }).run();
  cy.fit(undefined, 48);
}
function render(): void {
  summary();
  get("grouping").textContent = `Grouped by ${view.projection.join(" → ") || "each state"}`;
  cy.elements().remove(); cy.add(elements()); styleGraph(); cy.resize();
  layoutGraph();
  const groups = get("groups"); groups.replaceChildren();
  for (const group of view.groups) {
    const row = document.createElement("div"); row.className = "group-row";
    const expand = button(`${expanded.has(group.id) ? "Fold" : "Expand"} ${label(group)} · ${states(group.members.length)}`, () => {
      if (expanded.has(group.id)) expanded.delete(group.id); else expanded.add(group.id); render();
    });
    expand.setAttribute("aria-expanded", String(expanded.has(group.id))); expand.disabled = traceVisible;
    if (traceVisible) expand.title = "Hide the failing run to fold groups";
    row.append(expand);
    if (group.violating > 0) row.append(paragraph(`${brokenRules(groupRules(view, group))} · ${states(group.violating)}`, "break"));
    appendRules(row, rules(group).split(", "));
    if (expanded.has(group.id)) for (const [i, id] of group.members.entries()) row.append(button(stateLabel(group, i), () => { details(id); cy.$id(`s${id}`).select(); }));
    groups.append(row);
  }
  highlightTrace(); search(); document.documentElement.dataset["rendered"] = "true";
}
function regroup(): void {
  const projection = [get<HTMLSelectElement>("first").value, get<HTMLSelectElement>("second").value].filter(Boolean);
  if (new Set(projection).size !== projection.length) { get<HTMLSelectElement>("second").value = ""; projection.pop(); }
  view = buildModelView(data.graph, data.reports, data.view.partial, data.header, { projection }); expanded.clear();
  if (traceVisible) expandTraceGroups();
  render();
}
for (const [index, id] of ["first", "second"].entries()) {
  const select = get<HTMLSelectElement>(id);
  for (const name of ["", ...view.variables]) { const option = document.createElement("option"); option.value = name; option.textContent = name || "None (each state)"; select.append(option); }
  select.value = view.projection[index] ?? ""; select.onchange = regroup;
}
get("search").oninput = search;
get("fit").onclick = () => { cy.fit(undefined, 48); };
get("download-png").onclick = () => {
  const blob = cy.png({ output: "blob", full: true, scale: 2, bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() });
  const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = `${data.model.replace(/[^\w.-]/gu, "_")}.png`; link.click();
  setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
};
get("panel-toggle").onclick = () => {
  const hidden = !get("panel").hidden; get("panel").hidden = hidden; document.body.classList.toggle("panel-collapsed", hidden);
  get("panel-toggle").textContent = hidden ? "Show panel" : "Hide panel"; get("panel-toggle").setAttribute("aria-expanded", String(!hidden)); cy.resize();
};
window.addEventListener("resize", () => { cy.resize(); });
get("graph").onkeydown = event => {
  const delta: Record<string, { x: number; y: number }> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
  const pan = delta[event.key];
  if (pan !== undefined) cy.panBy(pan);
  else if (["+", "=", "-"].includes(event.key)) cy.zoom(cy.zoom() * (event.key === "-" ? .8 : 1.25));
  else return;
  event.preventDefault();
};
cy.on("tap", "node", event => {
  const target = event.target as cytoscape.NodeSingular;
  const group = view.groups.find(g => g.id === target.data("group"));
  if (group !== undefined && target.id().startsWith("g") && view.projection.length > 0) groupDetails(group);
  else { const ids = target.data("members") as string[]; if (ids[0] !== undefined) details(ids[0]); }
});
function expandTraceGroups(): void {
  for (const group of view.groups) if (view.trace.some(step => group.members.includes(step.fingerprint))) expanded.add(group.id);
}
get("trace-toggle").onclick = () => {
  traceVisible = !traceVisible;
  get("trace").hidden = !traceVisible; get("trace-toggle").setAttribute("aria-expanded", String(traceVisible));
  get("trace-toggle").textContent = traceVisible ? "Hide the failing run" : "Show the failing run";
  if (traceVisible) {
    openPanel();
    expanded.clear();
    expandTraceGroups();
  }
  render();
};
get<HTMLButtonElement>("trace-toggle").disabled = view.trace.length === 0;
const trace = get("trace");
const title = document.createElement("h2"); title.textContent = "The failing run"; trace.append(title);
let previous: ReadonlyMap<string, string> = new Map();
for (const [i, step] of view.trace.entries()) {
  const vars = stateVariables(step.valuation.split(/\r?\n/u));
  const changed = [...vars].filter(([k, v]) => previous.get(k) !== v).map(([k, v]) => i === 0 ? `${k} ${displayValue(v)}` : `${k} ${displayValue(previous.get(k) ?? "(missing)")} → ${displayValue(v)}`).join(", ");
  const broken = view.states.find(s => s.fingerprint === step.fingerprint)?.breaks ?? [];
  const item = button(`${i + 1}. ${i === 0 ? "Start" : step.action.replace(/ line \d+.*$/u, "")}: ${changed || "no variables changed"}${broken.length ? ` ${brokenRules(broken)}` : ""}`, () => {
    details(step.fingerprint); cy.nodes().unselect(); cy.$id(`s${step.fingerprint}`).select();
  });
  item.className = "trace-step"; trace.append(item); appendRules(trace, broken); previous = vars;
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", styleGraph);
render();
performance.mark("tesota-first-render");
