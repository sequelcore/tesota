import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { JSDOM } from "jsdom";
import { runHtml } from "./model-html-dom.js";
import { buildModelView } from "../src/model-view.js";
import { expect, it } from "vitest";
import { captureGraph, graphContentHash } from "../src/model-graph.js";
import { copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Core } from "cytoscape";
import { runProcess } from "../src/process.js";

function node<T extends Element = HTMLElement>(doc: Document, selector: string): T {
  const element = doc.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing ${selector}`);
  return element;
}
const attack = '</script><img onerror=alert(1)> & \u2028\u2029';
async function fixture(root: string): Promise<string> {
  const dot = `digraph {\n1 [label=${JSON.stringify(`/\\ pc = ${attack}\n/\\ x = 0`)}]\n2 [label=${JSON.stringify(`/\\ pc = ${attack}\n/\\ x = 1`)}]\n1 -> 2 [label=${JSON.stringify(attack)}]\n}`;
  await writeFile(join(root, "capture.dot"), dot);
  const manifest = join(root, "capture.manifest.json");
  await writeFile(manifest, JSON.stringify({ version: 1, status: "captured", exploration: "partial", binding: { model: attack },
    artifacts: { dot: { file: "capture.dot", sha256: graphContentHash(dot) } }, graph: {
      trace: [{ fingerprint: "1", action: "Init", valuation: `/\\ x = 0` }, { fingerprint: "2", action: attack, valuation: `/\\ x = 1` }], violations: { Safe: ["2"] } } }));
  return manifest;
}
function writeHtml(manifest: string): string {
  return execFileSync("bun", [resolve("packages/core/src/main.ts"), "graph", "--html", manifest], { encoding: "utf8" }).trim();
}
function assertSearchAndNavigation(page: JSDOM, cy: Core): void {
  const doc = page.window.document;
  const search = node<HTMLInputElement>(doc, "#search");
  for (const query of ["2", "Safe", "x = 1"]) {
    search.value = query; search.dispatchEvent(new page.window.Event("input"));
    expect(cy.nodes(".match").length).toBe(2); // state 2 and its expanded parent
  }
  search.value = attack.trim(); search.dispatchEvent(new page.window.Event("input"));
  expect(cy.edges(".match").length).toBe(1);
  const graph = node(doc, "#graph"), before = cy.zoom();
  graph.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "+" }));
  expect(cy.zoom()).toBeGreaterThan(before);
  const x = cy.pan().x;
  graph.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowRight" }));
  expect(cy.pan().x).toBe(x - 40);
}

it("writes a self-contained, CSP protected file beside the capture with escaped untrusted JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-"));
  try {
    const path = writeHtml(await fixture(root));
    expect(path).toBe(join(root, "capture.manifest.html"));
    const html = await readFile(path, "utf8");
    const dom = new JSDOM(html);
    const policy = dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("unsafe-inline");
    for (const element of dom.window.document.querySelectorAll("style, script:not([type])")) {
      const hash = createHash("sha256").update(element.textContent ?? "").digest("base64");
      expect(policy).toContain(`'sha256-${hash}'`);
    }
    expect([...dom.window.document.querySelectorAll("[src], [href]")]).toHaveLength(0);
    expect(html).not.toMatch(/fetch\s*\(/u);
    expect(html).not.toContain(attack);
    expect(html).toContain("\\u003c/script\\u003e");
    expect(dom.window.document.querySelector("img")).toBeNull();
    const data = JSON.parse(dom.window.document.querySelector("#model-data")?.textContent ?? "");
    expect(data.view.groups).toEqual(buildModelView(data.graph, data.reports, true, "", {}).groups);
    expect(data.view.groups.map((g: { members: string[]; violating: number }) => [g.members.length, g.violating])).toEqual([[2, 1]]);
    expect(data.view.partial).toBe(true);
    dom.window.close();
    const { dom: page, errors } = runHtml(html);
    try {
      const doc = page.window.document;
      expect(errors).toEqual([]);
      expect(doc.documentElement.dataset["rendered"]).toBe("true");
      expect(doc.querySelectorAll("style")).toHaveLength(1);
      expect(node(doc, "#counts").textContent).toContain("reached >=2");
      expect(node(doc, "#counts").textContent).toContain("reported violating >=1");
      const first = doc.querySelector<HTMLSelectElement>("#first");
      if (first === null) throw new Error("Missing grouping control");
      first.value = "x"; first.dispatchEvent(new page.window.Event("change"));
      expect(doc.querySelectorAll("#groups > div")).toHaveLength(2);
      expect(node(doc, "#counts").textContent).toContain("reached >=2");
      node<HTMLButtonElement>(doc, "#groups button").click();
      expect(node(doc, "#groups").textContent).toContain("State 1");
      const member = [...doc.querySelectorAll<HTMLButtonElement>("#groups button")].find(b => b.textContent === "State 1");
      member?.click();
      expect(node(doc, "#details").textContent).toContain(attack.trim());
      expect(doc.querySelector("img")).toBeNull();
      node<HTMLButtonElement>(doc, "#trace-toggle").click();
      expect(doc.querySelector<HTMLElement>("#trace")?.hidden).toBe(false);
      expect(doc.querySelectorAll(".trace-step")).toHaveLength(2);
      expect(node(doc, "#trace").textContent).toContain("Changed variables:");
      const canvas = node<HTMLElement & { _cyreg: { cy: Core } }>(doc, "#graph");
      expect(canvas._cyreg.cy.elements("node.trace").length).toBe(4);
      expect(canvas._cyreg.cy.elements("edge.trace").length).toBe(1);
      assertSearchAndNavigation(page, canvas._cyreg.cy);
      expect(errors).toEqual([]);
    } finally { page.window.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("renders the real 320-state fixture, conserves regrouped counts and expands all trace members", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-320-"));
  try {
    const operator = JSON.parse(process.env["TESOTA_TEST_OPERATOR_HOME"] ?? "{}") as { HOME?: string; USERPROFILE?: string };
    const jar = join(operator.USERPROFILE ?? operator.HOME ?? "", ".tesota", "tools", "tla2tools.jar");
    for (const ext of ["tla", "cfg"]) await copyFile(new URL(`./fixtures/model-view/HostSessions.${ext}`, import.meta.url), join(root, `HostSessions.${ext}`));
    const chunks: Buffer[] = [];
    const run = await runProcess("java", ["-cp", jar, "tlc2.TLC", "-workers", "1", "-continue", "-dump", "dot,actionlabels", "reached.dot", "HostSessions"], root, new AbortController().signal, 60_000, chunk => chunks.push(chunk));
    expect(run.exitCode).toBe(0);
    const capture = await captureGraph(join(root, "reached.dot"), Buffer.concat(chunks).toString("utf8"), {
      root, command: [], startedAt: "", finishedAt: "", processEnded: "exited", evidenceOutputHash: "", sessionFile: join(root, "s.jsonl"), model: "HostSessions.tla", config: "HostSessions.cfg", modelHash: "", configHash: "", effectiveConfigHash: "", evidenceHash: "", exitCode: 0,
    }, { sessionFile: join(root, "s.jsonl"), continue: true });
    expect(capture.status).toBe("captured");
    const path = writeHtml(capture.manifest ?? "");
    const html = await readFile(path, "utf8");
    const start = performance.now();
    const { dom, errors } = runHtml(html);
    try {
      const elapsed = performance.now() - start;
      process.stdout.write(`HostSessions HTML: ${Buffer.byteLength(html)} bytes; DOM first render ${elapsed.toFixed(1)} ms (canvas stub, not browser paint)\n`);
      const doc = dom.window.document;
      expect(errors).toEqual([]);
      expect(doc.documentElement.dataset["rendered"]).toBe("true");
      expect(node(doc, "#counts").textContent).toContain("reached 320");
      expect(node(doc, "#counts").textContent).toContain("reported violating 60");
      const data = JSON.parse(node(doc, "#model-data").textContent ?? "");
      const first = doc.querySelector<HTMLSelectElement>("#first");
      const second = doc.querySelector<HTMLSelectElement>("#second");
      if (first === null || second === null) throw new Error("Missing grouping controls");
      for (const projection of [[], ["age"], ["session", "host"]]) {
        const before = performance.now();
        first.value = projection[0] ?? ""; second.value = projection[1] ?? "";
        first.dispatchEvent(new dom.window.Event("change"));
        const expected = buildModelView(data.graph, data.reports, false, data.header, { projection });
        expect(doc.querySelectorAll("#groups > div")).toHaveLength(expected.groups.length);
        const labels = [...doc.querySelectorAll("#groups > div")].map(row => row.textContent);
        expected.groups.forEach((group, i) => {
          expect(labels[i]).toContain(`${group.members.length} members`);
          if (group.violating > 0) expect(labels[i]).toContain(`! BREAK ${group.violating}`);
          else expect(labels[i]).not.toContain("! BREAK");
        });
        expect(node(doc, "#counts").textContent).toContain("reached 320");
        expect(node(doc, "#counts").textContent).toContain("reported violating 60");
        process.stdout.write(`HostSessions regroup ${projection.join(",") || "each state"}: ${(performance.now() - before).toFixed(1)} ms\n`);
      }
      const base = buildModelView(data.graph, data.reports, false, data.header, { projection: ["session", "host"] });
      node<HTMLButtonElement>(doc, "#groups button").click();
      const display = buildModelView(data.graph, data.reports, false, data.header, { projection: base.projection, expanded: [base.groups[0]?.id ?? ""] });
      const cy = (doc.querySelector("#graph") as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
      expect(cy.edges().map(e => e.data("label")).sort()).toEqual(display.edges.map(e => `${e.action} ×${e.count}`).sort());
      expect(node(doc, "#groups button").textContent).toContain("Fold");
      node<HTMLButtonElement>(doc, "#groups button").click();
      expect(node(doc, "#groups button").textContent).toContain("Expand");
      node<HTMLButtonElement>(doc, "#trace-toggle").click();
      expect(doc.querySelectorAll(".trace-step")).toHaveLength(data.view.trace.length);
      expect(node(doc, "#groups").textContent).toContain(`State ${data.view.trace[0].fingerprint}`);
      expect(errors).toEqual([]);
    } finally { dom.window.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 90_000);

it("keeps folded edge multiplicities when a different group is expanded through the model owner", () => {
  const graph = { states: ["a", "b", "b", "c"].map((pc, i) => ({ fingerprint: String(i + 1), valuation: `/\\ pc = ${pc}` })),
    edges: [{ from: "2", to: "4", action: "Go" }, { from: "3", to: "4", action: "Go" }] };
  const reports = { trace: [], violations: {} };
  const request = { projection: ["pc"], expanded: [JSON.stringify([["pc", "a"]])] };
  const view = buildModelView(graph, reports, false, "", request);
  expect(view.groups.find(g => g.id === "1")?.members).toEqual(["1"]);
  expect(view.edges.map(e => e.count)).toEqual([2]);
});

it("writes next to a manifest even when the operator supplied a path without an extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-stem-"));
  try {
    const manifest = await fixture(root);
    const extensionless = join(root, "renamed");
    await copyFile(manifest, extensionless);
    expect(writeHtml(extensionless)).toBe(join(root, "renamed.html"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
