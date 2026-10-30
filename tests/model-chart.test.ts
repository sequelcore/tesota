import { existsSync } from "node:fs";
import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { register, render } from "pele/core";
import flowchart from "pele/diagrams/flowchart";
import { afterEach, expect, it } from "vitest";
import { buildChart, CHART_STATES, chartMermaid, type ChartReading } from "../src/model-chart.js";
import { tlaValue } from "../src/model-state.js";
import { loadModelView } from "../src/model-view-process.js";
import { trustReading } from "./trust-reading.js";

register(flowchart);
const fixture = fileURLToPath(new URL("./fixtures/model-chart/", import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** The DNS enactors capture, its model and its reading in a fresh folder, as a session would hold them. */
async function dnsCapture(): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-chart-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  const manifest = join(root, "dns-stale.manifest.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify({ ...data, binding: { ...data.binding, root } }));
  return { root, manifest };
}
const chartOf = async (manifest: string) => {
  const view = await loadModelView(manifest, { chart: true }, new AbortController().signal);
  if (view.chart === undefined) throw new Error("No chart in the view");
  return { view, chart: view.chart };
};

it("reads TLC's values as the reading gets them", () => {
  expect(tlaValue("<<0, 1>>")).toEqual([0, 1]);
  expect(tlaValue("{}")).toEqual([]);
  expect(tlaValue("<<>>")).toEqual([]);
  expect(tlaValue('{"a", "b, c"}')).toEqual(["a", "b, c"]);
  expect(tlaValue("[x |-> 1, y |-> <<TRUE, FALSE>>]")).toEqual({ x: 1, y: [true, false] });
  expect(tlaValue('(1 :> "on" @@ 2 :> "off")')).toEqual({ 1: "on", 2: "off" });
  expect(tlaValue("-3")).toBe(-3);
  expect(tlaValue("idle")).toBe("idle");
  expect(tlaValue("<<1, ")).toBe("<<1, ");
});

/** A reading that leaves a mark when it runs, so a test sees whether it was imported at all. */
const marking = (marker: string, label = "marked"): string => `import { writeFileSync } from "node:fs";\n` +
  `writeFileSync(${JSON.stringify(marker)}, "ran");\nexport function state(): string { return ${JSON.stringify(label)}; }\n`;

it("never runs a reading the operator hasn't trusted, and says how to trust it", async () => {
  const { root, manifest } = await dnsCapture();
  const marker = join(root, "ran");
  await writeFile(join(root, "DnsPlans.chart.ts"), marking(marker));
  const { chart } = await chartOf(manifest);
  expect(existsSync(marker)).toBe(false);
  expect(chart.reading).toBeUndefined();
  expect(chart.projection).toEqual(["published"]);
  expect(chart.note).toContain("DnsPlans.chart.ts wasn't run: this project's chart readings aren't trusted");
  expect(chart.note).toContain("/graph");
  expect(chart.note).not.toContain("Write DnsPlans.chart.ts");
  expect(chart.path).toHaveLength(7);
});

it("runs a reading the operator trusted as it is now", async () => {
  const { root, manifest } = await dnsCapture();
  const marker = join(root, "ran");
  await writeFile(join(root, "DnsPlans.chart.ts"), marking(marker));
  trustReading(root, "DnsPlans.chart.ts");
  const { chart } = await chartOf(manifest);
  expect(existsSync(marker)).toBe(true);
  expect(chart.reading).toBe("DnsPlans.chart.ts");
  expect(chart.nodes.map((node) => node.label)).toEqual(["marked"]);
});

it("asks again once a trusted reading changes, and never runs the changed one", async () => {
  const { root, manifest } = await dnsCapture();
  const marker = join(root, "ran");
  await writeFile(join(root, "DnsPlans.chart.ts"), marking(marker));
  trustReading(root, "DnsPlans.chart.ts");
  await appendFile(join(root, "DnsPlans.chart.ts"), "// changed after it was trusted\n");
  const { chart } = await chartOf(manifest);
  expect(existsSync(marker)).toBe(false);
  expect(chart.reading).toBeUndefined();
  expect(chart.note).toContain("aren't trusted");
});

it("opens the DNS stale write on its reading: a few labeled states and the breaking path numbered", async () => {
  const { root, manifest } = await dnsCapture();
  trustReading(root, "DnsPlans.chart.ts");
  const before = await readFile(manifest);
  const { view, chart } = await chartOf(manifest);
  expect(chart.reading).toBe("DnsPlans.chart.ts");
  expect(chart.opens).toBe("chart");
  expect(chart.nodes.length).toBeGreaterThanOrEqual(3);
  expect(chart.nodes.length).toBeLessThanOrEqual(6);
  expect(chart.path.map((step) => `${step.number}. ${step.label}`)).toEqual([
    "1. the planner publishes plan 1", "2. the planner publishes plan 2", "3. enactor 1 picks plan 2",
    "4. the planner publishes plan 3", "5. enactor 2 picks plan 3", "6. enactor 2 writes plan 3 to endpoint 1",
    "7. enactor 1 writes plan 2 to endpoint 1"]);
  expect(chart.path.map((step) => step.action)).toEqual(["Publish", "Publish", "Select", "Publish", "Select", "Point", "Point"]);
  const broken = chart.nodes.filter((node) => node.breaks.length > 0);
  expect(broken.map((node) => [node.label, node.breaks])).toEqual([["an endpoint went back to an older plan", ["Safety"]]]);
  expect(chart.path.at(-1)?.to).toBe(broken[0]?.id);
  expect(chart.nodes.find((node) => node.start)?.id).toBe(chart.path[0]?.from);
  // Every reached state is in exactly one node: the reading regroups TLC's graph, it adds or drops nothing.
  expect(chart.nodes.flatMap((node) => node.members).sort()).toEqual(view.states.map((state) => state.fingerprint).sort());
  expect(view.plain.split("\n").slice(0, 3).join("\n")).toContain("DnsPlans.chart.ts");
  expect(view.plain).toContain("7. enactor 1 writes plan 2 to endpoint 1");
  const mermaid = chartMermaid(chart, "LR");
  // Pele wraps a long label into lines of its own.
  const svg = render(mermaid).svg;
  expect(svg).toContain("an endpoint went back to</tspan>");
  expect(svg).toContain("7. enactor 1 writes plan 2 to</tspan>");
  expect(mermaid).toContain(`class ${broken[0]?.id} broken`);
  expect(await readFile(manifest)).toEqual(before);
});

it("without a reading, groups by the control variable, numbers the path and names the format", async () => {
  const { root, manifest } = await dnsCapture();
  await rm(join(root, "DnsPlans.chart.ts"));
  const { chart } = await chartOf(manifest);
  expect(chart.reading).toBeUndefined();
  expect(chart.projection).toEqual(["published"]);
  expect(chart.note).toContain("DnsPlans.chart.ts");
  expect(chart.note).toContain("state(v)");
  expect(chart.nodes.map((node) => node.label)).toEqual(["published: 0", "published: 1", "published: 2", "published: 3", "published: 4"]);
  expect(chart.path.map((step) => step.label)).toEqual(["Publish", "Publish", "Select", "Publish", "Select", "Point", "Point"]);
  expect(chart.path.map((step) => step.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(chart.opens).toBe("chart");
  expect(render(chartMermaid(chart, "TB")).svg).toContain("published: 3");
});

it("falls back and says why when the reading fails or gives no label", async () => {
  const { root, manifest } = await dnsCapture();
  for (const [source, why] of [
    ["export function state(): string { throw new Error(\"boom\"); }", "boom"],
    ["export function state(): string { return \"\"; }", "no label"],
    ["export const nothing = 1;", "state(v)"],
    ["export function state( {", "DnsPlans.chart.ts"],
  ] as const) {
    await writeFile(join(root, "DnsPlans.chart.ts"), source);
    trustReading(root, "DnsPlans.chart.ts");
    const { chart } = await chartOf(manifest);
    expect(chart.reading).toBeUndefined();
    expect(chart.projection).toEqual(["published"]);
    expect(chart.note).toContain(why);
    expect(chart.path).toHaveLength(7);
  }
});

const chain = (count: number, broken: boolean) => ({
  graph: { states: Array.from({ length: count }, (_, i) => ({ fingerprint: String(i + 1), valuation: `/\\ x = ${i}\n/\\ done = FALSE` })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ from: String(i + 1), to: String(i + 2), action: "Next" })) },
  reports: broken
    ? { trace: [1, 2, 3].map((n) => ({ fingerprint: String(n), action: n === 1 ? "Initial predicate" : "Next line 3, col 1 to line 3, col 9 of module M", valuation: `/\\ x = ${n - 1}\n/\\ done = FALSE` })),
      violations: { Small: ["3"] } }
    : { trace: [], violations: {} },
});

it("opens a model whose rules hold on its whole chart while it is small, and on TLC's graph past the budget", () => {
  const small = chain(5, false);
  const chart = buildChart(small.graph, small.reports, false, "", { file: "M.chart.ts", reason: "M.chart.ts does not exist" });
  expect(chart.opens).toBe("chart");
  expect(chart.path).toEqual([]);
  expect(chart.nodes).toHaveLength(5);
  const big = chain(CHART_STATES + 10, false);
  expect(buildChart(big.graph, big.reports, false, "", { file: "M.chart.ts", reason: "M.chart.ts does not exist" }).opens).toBe("graph");
});

it("past the budget, a broken rule keeps the path's states and folds the rest", () => {
  const big = chain(CHART_STATES + 10, true);
  const chart = buildChart(big.graph, big.reports, false, "", { file: "M.chart.ts", reason: "M.chart.ts does not exist" });
  expect(chart.opens).toBe("chart");
  // Sixty values of x leave no control variable, so each state is its own node until folded.
  expect(chart.nodes.map((node) => node.label)).toEqual(["x: 0 · done: FALSE", "x: 1 · done: FALSE", "x: 2 · done: FALSE"]);
  expect(chart.folded).toBe(CHART_STATES + 7);
  expect(chart.path.map((step) => step.label)).toEqual(["Next", "Next"]);
});

it("draws a reading's groups as boxes and keeps its words out of Mermaid's syntax", () => {
  const small = chain(4, true);
  const reading: ChartReading = { file: "M.chart.ts",
    state: (v) => `x is "${String(v["x"])}" #1 <b> --> end`,
    group: (v) => Number(v["x"]) < 2 ? "low" : "high",
    step: (action, before, after) => `${action} ${String(before["x"])} to ${String(after["x"])}` };
  const chart = buildChart(small.graph, small.reports, false, "", reading);
  expect(chart.reading).toBe("M.chart.ts");
  expect(chart.nodes.map((node) => node.group)).toEqual(["low", "low", "high", "high"]);
  expect(chart.path.map((step) => step.label)).toEqual(["Next 0 to 1", "Next 1 to 2"]);
  const mermaid = chartMermaid(chart, "LR");
  expect(mermaid.match(/subgraph /gu)).toHaveLength(2);
  const svg = render(mermaid).svg;
  expect(svg).toContain("x is &quot;0&quot; #1 &lt;b&gt; --&gt; end");
  expect(svg).not.toContain("<b>");
});
