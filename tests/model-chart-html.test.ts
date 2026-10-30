import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Core } from "cytoscape";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import { runHtml } from "./model-html-dom.js";
import { trustReading } from "./trust-reading.js";

const fixture = fileURLToPath(new URL("./fixtures/model-chart/", import.meta.url));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function dnsCapture(change: (data: Record<string, unknown>) => Record<string, unknown> = (data) => data): Promise<{ root: string; manifest: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-chart-html-"));
  roots.push(root);
  await cp(fixture, root, { recursive: true });
  const manifest = join(root, "dns-stale.manifest.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  await writeFile(manifest, JSON.stringify(change({ ...data, binding: { ...data.binding, root } })));
  return { root, manifest };
}
const page = async (manifest: string) => runHtml(await readFile(
  execFileSync("bun", [resolve("packages/core/src/main.ts"), "graph", "--html", manifest], { encoding: "utf8" }).trim(), "utf8"));
function node<T extends Element = HTMLElement>(doc: Document, selector: string): T {
  const element = doc.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}
/** SVG text as read: Pele wraps a long label into one tspan per line. */
const words = (element: Element): string => [...element.querySelectorAll("text")]
  .map((text) => text.querySelector("tspan") === null ? text.textContent : [...text.querySelectorAll("tspan")].map((line) => line.textContent).join(" ")).join(" ");
/** Every edge label's box lies inside the chart's view, so none is clipped at an edge of the pane. */
function expectLabelsInView(doc: Document): void {
  const [x = 0, y = 0, width = 0, height = 0] = (node(doc, "#chart svg").getAttribute("viewBox") ?? "").split(/\s+/u).map(Number);
  const boxes = [...doc.querySelectorAll("#chart .pele-edge-label rect")].map((rect) => ["x", "y", "width", "height"].map((name) => Number(rect.getAttribute(name))));
  expect(boxes.length).toBeGreaterThan(0);
  for (const [left = 0, top = 0, wide = 0, high = 0] of boxes) {
    expect(left).toBeGreaterThanOrEqual(x);
    expect(top).toBeGreaterThanOrEqual(y);
    expect(left + wide).toBeLessThanOrEqual(x + width);
    expect(top + high).toBeLessThanOrEqual(y + height);
  }
}
const cyOf = (doc: Document): Core => node<HTMLElement & { _cyreg: { cy: Core } }>(doc, "#graph")._cyreg.cy;

it("opens the DNS stale write on its chart, offline and under the page's policy, with TLC's graph one click away", async () => {
  const { root, manifest } = await dnsCapture();
  trustReading(root, "DnsPlans.chart.ts");
  const path = execFileSync("bun", [resolve("packages/core/src/main.ts"), "graph", "--html", manifest], { encoding: "utf8" }).trim();
  const html = await readFile(path, "utf8");
  const plain = new JSDOM(html).window.document;
  const policy = plain.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
  expect(policy).toContain("style-src-attr 'none'");
  for (const element of plain.querySelectorAll("style, script:not([type])")) {
    expect(policy).toContain(`'sha256-${createHash("sha256").update(element.textContent ?? "").digest("base64")}'`);
  }
  expect([...plain.querySelectorAll("[src], [href]")]).toHaveLength(0);
  expect(plain.querySelector("style")?.textContent).toContain("--pele-bg:var(--bg)");
  expect(html).toContain("Pele");

  const { dom, errors } = runHtml(html);
  try {
    const doc = dom.window.document;
    expect(errors).toEqual([]);
    expect(node(doc, "#title").textContent).toBe("TLC found a state that breaks Safety in 7 steps from the start");
    expect(node(doc, "#chart").hidden).toBe(false);
    expect(node(doc, "#graph").hidden).toBe(true);
    expect(node(doc, "#chart-note").textContent).toContain("DnsPlans.chart.ts");
    expect(doc.querySelectorAll("#chart svg")).toHaveLength(1);
    expectLabelsInView(doc);
    expect([...doc.querySelectorAll("#chart .pele-node.broken")].map(words)).toEqual(
      [expect.stringContaining("an endpoint went back to an older plan")]);
    expect(doc.querySelectorAll("#chart .pele-node").length).toBeLessThanOrEqual(6);
    const labels = [...doc.querySelectorAll("#chart .pele-edge-label.path")].map(words).join(" ");
    for (const step of ["1. the planner publishes plan 1", "6. enactor 2 writes plan 3 to endpoint 1", "7. enactor 1 writes plan 2 to endpoint 1"]) {
      expect(labels).toContain(step);
    }
    expect([...doc.querySelectorAll(".chart-step")].map((element) => element.textContent)).toEqual([
      expect.stringContaining("1. the planner publishes plan 1"), expect.anything(), expect.anything(), expect.anything(),
      expect.anything(), expect.anything(), expect.stringContaining("7. enactor 1 writes plan 2 to endpoint 1")]);
    expect(node(doc, ".chart-step:last-of-type").textContent).toContain("TLC: Point");
    node<HTMLButtonElement>(doc, ".chart-step:last-of-type").click();
    expect(node(doc, "#details").textContent).toContain("highWater");

    node<HTMLButtonElement>(doc, "#view-toggle").click();
    expect(node(doc, "#chart").hidden).toBe(true);
    expect(node(doc, "#graph").hidden).toBe(false);
    expect(cyOf(doc).nodes().length).toBeGreaterThan(0);
    expect(node(doc, "#view-toggle").textContent).toBe("Show the chart");
    node<HTMLButtonElement>(doc, "#view-toggle").click();
    expect(node(doc, "#chart").hidden).toBe(false);
    expect(errors).toEqual([]);
  } finally { dom.window.close(); }
});

it("keeps a self-loop's labels inside the view when the start state's label is narrower than they are", async () => {
  const { root, manifest } = await dnsCapture();
  // A start state shorter than its loop's steps: Pele centers the loop's label on the state and draws it left of the view.
  const reading = join(root, "DnsPlans.chart.ts");
  await writeFile(reading, (await readFile(reading, "utf8")).replace(': "nothing served yet"', ': "idle"'));
  trustReading(root, "DnsPlans.chart.ts");
  const { dom, errors } = await page(manifest);
  try {
    const doc = dom.window.document;
    expect(errors).toEqual([]);
    expect(words(node(doc, "#chart .pele-node.start"))).toContain("idle");
    expectLabelsInView(doc);
  } finally { dom.window.close(); }
});

it("opens a model whose rules all hold on its whole chart", async () => {
  const { manifest } = await dnsCapture((data) => ({ ...data, graph: { ...data["graph"] as object, trace: [], violations: {} } }));
  const { dom, errors } = await page(manifest);
  try {
    const doc = dom.window.document;
    expect(errors).toEqual([]);
    expect(node(doc, "#chart").hidden).toBe(false);
    expect(doc.querySelectorAll("#chart .pele-node.broken")).toHaveLength(0);
    expect(doc.querySelectorAll("#chart .pele-node").length).toBeGreaterThanOrEqual(3);
    expect(doc.querySelectorAll(".chart-step")).toHaveLength(0);
  } finally { dom.window.close(); }
});

it("without a reading, opens grouped by the control variable with the path numbered, and says why", async () => {
  const { root, manifest } = await dnsCapture();
  await rm(join(root, "DnsPlans.chart.ts"));
  const { dom, errors } = await page(manifest);
  try {
    const doc = dom.window.document;
    expect(errors).toEqual([]);
    expect(node(doc, "#chart").hidden).toBe(false);
    expect(doc.querySelectorAll("#chart .pele-node")).toHaveLength(5);
    expect(node(doc, "#chart-note").textContent).toContain("published");
    expect(node(doc, "#chart-note").textContent).toContain("DnsPlans.chart.ts");
    expect([...doc.querySelectorAll("#chart .pele-edge-label.path")].map(words).join(" ")).toContain("7. Point");
  } finally { dom.window.close(); }
});

it("Show the failing run folds TLC's graph to the run's states in order, and hiding it returns to the view before", async () => {
  const { manifest } = await dnsCapture();
  const { dom, errors } = await page(manifest);
  try {
    const doc = dom.window.document;
    node<HTMLButtonElement>(doc, "#view-toggle").click();
    node<HTMLButtonElement>(doc, "#groups button").click();
    const cy = cyOf(doc);
    const before = cy.nodes().map((element) => element.id()).sort();
    node<HTMLButtonElement>(doc, "#trace-toggle").click();
    const leaves = cy.nodes().filter((element) => element.isChildless());
    expect(leaves).toHaveLength(8);
    expect(leaves.map((element) => String(element.data("label")).split("\n")[0])).toEqual(
      ["start", "step 1", "step 2", "step 3", "step 4", "step 5", "step 6", "step 7"]);
    expect(cy.edges().map((element) => String(element.data("label")))).toEqual(
      ["1. Publish", "2. Publish", "3. Select", "4. Publish", "5. Select", "6. Point", "7. Point"]);
    expect(cy.nodes(".break")).toHaveLength(1);
    expect(node(doc, "#grouping").textContent).toContain("other states folded");
    node<HTMLButtonElement>(doc, "#trace-toggle").click();
    expect(cy.nodes().map((element) => element.id()).sort()).toEqual(before);
    expect(errors).toEqual([]);
  } finally { dom.window.close(); }
});
