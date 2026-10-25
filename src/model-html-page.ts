import cytoscape from "cytoscape";
import { boundedCount, buildModelView, type ViewGroup } from "./model-view.js";
import { stateVariables } from "./model-state.js";
import type { HtmlModel } from "./model-html.js";

const data = JSON.parse(document.querySelector("#model-data")?.textContent ?? "") as HtmlModel;
const get = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
let view = data.view;
const expanded = new Set<string>();
let traceVisible = false;
const colors = (): { bg: string; fg: string; error: string; accent: string } => {
  const style = getComputedStyle(document.documentElement);
  return { bg: style.getPropertyValue("--panel").trim(), fg: style.getPropertyValue("--fg").trim(),
    error: style.getPropertyValue("--error").trim(), accent: style.getPropertyValue("--accent").trim() };
};
const cy = cytoscape({ container: get("graph"), elements: [], layout: { name: "grid" }, minZoom: .05, maxZoom: 5 });
const count = (n: number): string => boundedCount(view.partial, n);
const label = (g: ViewGroup): string => g.path.length === 0 ? g.members[0] ?? "" : g.path.map(([k, v]) => `${k} = ${v}`).join(" › ");
function button(text: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button"); element.textContent = text; element.onclick = action; return element;
}
function details(id: string): void {
  const state = view.states.find(s => s.fingerprint === id);
  const panel = get("details"); panel.replaceChildren();
  const title = document.createElement("h3"); title.textContent = `State ${id}`; panel.append(title);
  const status = document.createElement("p"); status.textContent = state?.breaks.length ? `! BREAK ${state.breaks.join(", ")}` : "No violation reported for this state";
  if (state?.breaks.length) status.className = "break";
  const pre = document.createElement("pre"); pre.textContent = Object.entries(state?.variables ?? {}).map(([k,v]) => `${k} = ${v}`).join("\n"); panel.append(status, pre);
}
function elements(): cytoscape.ElementDefinition[] {
  const nodeIds = new Map<string, string>();
  const nodes: cytoscape.ElementDefinition[] = [];
  for (const [i, group] of view.groups.entries()) {
    const gid = `g${i}`;
    if (!expanded.has(group.id)) nodeIds.set(group.id, gid);
    nodes.push({ data: { id: gid, label: `${label(group)}\n${count(group.members.length)} members`, members: group.members, group: group.id } });
    if (group.violating > 0) nodes.push({ data: { id: `b${i}`, label: `! BREAK ${count(group.violating)}`, parent: gid, group: group.id }, classes: "break" });
    for (const id of group.members) {
      const nid = expanded.has(group.id) ? `s${id}` : gid;
      if (expanded.has(group.id)) nodeIds.set(id, nid);
      if (expanded.has(group.id)) nodes.push({ data: { id: nid, parent: gid, label: id, members: [id], group: group.id } });
    }
  }
  // The model owns mixed expansion too: folded groups retain aggregated multiplicities.
  const displayed = expanded.size === 0 ? view : buildModelView(data.graph, data.reports, view.partial, data.header,
    { projection: view.projection, expanded: [...expanded] });
  const edges = displayed.edges.map((e, i) => ({ data: { id: `e${i}`, source: nodeIds.get(e.from), target: nodeIds.get(e.to), label: `${e.action} ×${count(e.count)}`, action: e.action } }));
  return [...nodes, ...edges];
}
function styleGraph(): void {
  const c = colors();
  cy.style().selector("node").style({ "background-color": c.bg, color: c.fg, label: "data(label)", "text-wrap": "wrap", "text-max-width": "220px", width: 160, height: 65, "font-size": 12 })
    .selector("edge").style({ label: "data(label)", color: c.fg, "line-color": c.accent, "target-arrow-color": c.accent, "target-arrow-shape": "triangle", "curve-style": "bezier", "font-size": 10 })
    .selector(".break").style({ color: c.error, "background-color": c.bg, shape: "round-rectangle", width: 110, height: 25 })
    .selector(".trace").style({ "border-color": c.accent, "border-width": 5, "line-color": c.accent })
    .selector(".match").style({ "border-color": c.accent, "border-width": 3, "line-color": c.accent })
    .selector(":selected").style({ "border-color": c.accent, "border-width": 3 }).update();
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
    if (previous !== undefined) cy.edges().filter(e => e.source().id() === `s${previous.fingerprint}` && e.target().id() === `s${step.fingerprint}` && (step.action === e.data("action") || step.action.startsWith(`${String(e.data("action"))} line `))).addClass("trace");
  }
}
function render(): void {
  get("title").textContent = `Model graph · ${data.model}`;
  get("counts").textContent = `${view.partial ? "Partial exploration; counts are lower bounds" : "Complete exploration; exact counts"} · reached ${count(view.states.length)} · reported violating ${count(view.violations.length)} (zero reports do not establish safety)`;
  get("grouping").textContent = `Grouped by ${view.projection.join(" > ") || "each state"}`;
  cy.elements().remove(); cy.add(elements()); styleGraph(); cy.layout({ name: "grid", animate: false }).run();
  const groups = get("groups"); groups.replaceChildren();
  for (const group of view.groups) {
    const row = document.createElement("div");
    const expand = button(`${expanded.has(group.id) ? "Fold" : "Expand"} ${label(group)} · ${count(group.members.length)} members`, () => {
      if (expanded.has(group.id)) expanded.delete(group.id); else expanded.add(group.id); render();
    });
    expand.setAttribute("aria-expanded", String(expanded.has(group.id)));
    expand.disabled = traceVisible;
    if (traceVisible) expand.title = "Hide TLC's concrete trace to fold groups";
    row.append(expand);
    if (group.violating > 0) { const mark = document.createElement("span"); mark.className = "break"; mark.textContent = ` ! BREAK ${count(group.violating)}`; row.append(mark); }
    if (expanded.has(group.id)) for (const id of group.members) row.append(button(`State ${id}`, () => { details(id); }));
    groups.append(row);
  }
  highlightTrace(); search();
  document.documentElement.dataset["rendered"] = "true";
}
function regroup(): void {
  const projection = [get<HTMLSelectElement>("first").value, get<HTMLSelectElement>("second").value].filter(Boolean);
  if (new Set(projection).size !== projection.length) { get<HTMLSelectElement>("second").value = ""; projection.pop(); }
  view = buildModelView(data.graph, data.reports, data.view.partial, data.header, { projection }); expanded.clear();
  if (traceVisible) for (const group of view.groups) expanded.add(group.id);
  render();
}
for (const [index, id] of ["first", "second"].entries()) {
  const select = get<HTMLSelectElement>(id);
  for (const name of ["", ...view.variables]) { const option = document.createElement("option"); option.value = name; option.textContent = name || "None (each state)"; select.append(option); }
  select.value = view.projection[index] ?? ""; select.onchange = regroup;
}
get("search").oninput = search;
get("fit").onclick = () => { cy.fit(); };
get("graph").onkeydown = event => {
  const delta: Record<string, { x: number; y: number }> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 }, ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
  const pan = delta[event.key];
  if (pan !== undefined) cy.panBy(pan);
  else if (["+", "=", "-"].includes(event.key)) cy.zoom(cy.zoom() * (event.key === "-" ? .8 : 1.25));
  else return;
  event.preventDefault();
};
cy.on("tap", "node", event => {
  const ids = event.target.data("members") as string[] | undefined;
  if (ids?.[0] === undefined) return;
  details(ids[0]);
  if (ids.length > 1) {
    const note = document.createElement("p"); note.textContent = `Showing the first of ${count(ids.length)} members. Expand the group to choose a different state.`;
    get("details").prepend(note);
  }
});
get("trace-toggle").onclick = () => {
  traceVisible = !traceVisible;
  get("trace").hidden = !traceVisible; get("trace-toggle").setAttribute("aria-expanded", String(traceVisible));
  if (traceVisible) for (const group of view.groups) expanded.add(group.id);
  render();
};
const trace = get("trace");
const title = document.createElement("h2"); title.textContent = "TLC concrete trace · the only execution shown, not regrouped or filtered"; trace.append(title);
let previous: ReadonlyMap<string, string> = new Map();
for (const [i, step] of view.trace.entries()) {
  const variables = stateVariables(step.valuation.split(/\r?\n/u));
  const changed = [...variables].filter(([k, v]) => previous.get(k) !== v).map(([k, v]) => `${k} = ${v}`).join("\n");
  const item = button(`${i + 1}. ${step.fingerprint} <${step.action}>\nChanged variables:\n${changed || "(none)"}`, () => { details(step.fingerprint); });
  item.className = "trace-step"; trace.append(item); previous = variables;
}
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", styleGraph);
render();
// The initial layout and element creation have completed; browser paint follows this task.
performance.mark("tesota-first-render");
