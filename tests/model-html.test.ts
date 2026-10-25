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
    expect(path).toBe(join(root, "capture.html"));
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
      expect(node(doc, "#counts").textContent).toContain("reached ≥2");
      expect(node(doc, "#counts").textContent).toContain("reported violating ≥1");
      const first = doc.querySelector<HTMLSelectElement>("#first");
      if (first === null) throw new Error("Missing grouping control");
      first.value = "x"; first.dispatchEvent(new page.window.Event("change"));
      expect(doc.querySelectorAll("#groups > div")).toHaveLength(2);
      expect(node(doc, "#counts").textContent).toContain("reached ≥2");
      node<HTMLButtonElement>(doc, "#groups button").click();
      expect(node(doc, "#groups").textContent).toContain("state 1 of 1");
      const member = [...doc.querySelectorAll<HTMLButtonElement>("#groups button")].find(b => b.textContent === "state 1 of 1");
      member?.click();
      expect(node(doc, "#details").textContent).toContain(attack.trim());
      expect(doc.querySelector("img")).toBeNull();
      node<HTMLButtonElement>(doc, "#trace-toggle").click();
      expect(doc.querySelector<HTMLElement>("#trace")?.hidden).toBe(false);
      expect(doc.querySelectorAll(".trace-step")).toHaveLength(2);
      expect(node(doc, "#trace").textContent).toContain("x 0 → 1");
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
          expect(labels[i]).toContain(`${group.members.length} ${group.members.length === 1 ? "state" : "states"}`);
          if (group.violating > 0) expect(labels[i]).toContain(`⚠ breaks NoParkedWork · ${group.violating} ${group.violating === 1 ? "state" : "states"}`);
          else expect(labels[i]).not.toContain("⚠ breaks");
        });
        expect(node(doc, "#counts").textContent).toContain("reached 320");
        expect(node(doc, "#counts").textContent).toContain("reported violating 60");
        process.stdout.write(`HostSessions regroup ${projection.join(",") || "each state"}: ${(performance.now() - before).toFixed(1)} ms\n`);
      }
      const base = buildModelView(data.graph, data.reports, false, data.header, { projection: ["session", "host"] });
      node<HTMLButtonElement>(doc, "#groups button").click();
      const display = buildModelView(data.graph, data.reports, false, data.header, { projection: base.projection, expanded: [base.groups[0]?.id ?? ""] });
      const cy = (doc.querySelector("#graph") as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
      expect(cy.edges().map(e => e.data("label")).sort()).toEqual(display.edges.map(e => `${e.action}${e.count > 1 ? ` ×${e.count}` : ""}`).sort());
      expect(node(doc, "#groups button").textContent).toContain("Fold");
      node<HTMLButtonElement>(doc, "#groups button").click();
      expect(node(doc, "#groups button").textContent).toContain("Expand");
      node<HTMLButtonElement>(doc, "#groups > div:last-child > button").click(); // unrelated manual expansion
      expect(node(doc, "#groups > div:last-child > button").getAttribute("aria-expanded")).toBe("true");
      node<HTMLButtonElement>(doc, "#trace-toggle").click();
      expect(doc.querySelectorAll('#groups button[aria-expanded="true"]')).toHaveLength(3);
      expect(doc.querySelectorAll(".trace-step")).toHaveLength(data.view.trace.length);
      expect(node(doc, "#groups").textContent).toContain("state 1 of");
      const leaves = cy.nodes().filter(n => n.isChildless());
      for (const leaf of leaves.filter(n => n.id().startsWith("s"))) {
        expect(leaf.data("label")).toContain("host:");
        expect(leaf.data("label")).toContain("session:");
      }
      expect(new Set(leaves.map(n => (n.scratch("breadthfirst") as { depth: number }).depth)).size).toBeGreaterThan(1);
      expect(leaves.filter(n => n.hasClass("start")).map(n => n.data("members"))).toEqual([[data.view.trace[0].fingerprint]]);
      for (const step of data.view.trace) expect(cy.$id(`s${step.fingerprint}`).length).toBe(1);
      expect(cy.nodes().boundingBox().w).toBeLessThan(10_000);
      expect(cy.nodes().boundingBox().h).toBeLessThan(10_000);
      for (const parent of cy.nodes(":parent")) {
        expect(parent.style("label")).toBe("");
        expect(parent.style("border-width")).toBe("0px");
        expect(parent.style("background-opacity")).toBe("0");
      }
      first.value = "age"; second.value = ""; first.dispatchEvent(new dom.window.Event("change"));
      expect(doc.querySelectorAll('#groups button[aria-expanded="true"]')).toHaveLength(1);
      expect(cy.nodes(":parent")).toHaveLength(1); // only age=0 holds failing-run states
      expect(cy.nodes().filter(n => n.id().startsWith("s"))).toHaveLength(64); // 4 hosts × 4 sessions × 4 job counts
      expect([...doc.querySelectorAll<HTMLButtonElement>("#groups button[aria-expanded]")].every(b => b.disabled)).toBe(true);
      for (const step of data.view.trace) expect(cy.$id(`s${step.fingerprint}`).length).toBe(1);
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
    const captureName = join(root, "session.jsonl.model-example.manifest.json");
    await copyFile(manifest, captureName);
    expect(writeHtml(captureName)).toBe(join(root, "session.jsonl.model-example.html"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("summarizes only reported violations and distinguishes partial exploration", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-summary-"));
  try {
    const manifest = await fixture(root);
    const original = JSON.parse(await readFile(manifest, "utf8"));
    for (const [violating, trace, partial, sentence, note] of [
      [true, true, true, "TLC found a state that breaks Safe in 1 step from the start", "x: 1"],
      [true, false, false, "TLC found a state that breaks Safe", "x: 1"],
      [false, false, true, "TLC reported no broken rule in the states it reached", "exploration was partial, so this is not proof of safety"],
      [false, false, false, "TLC reported no broken rule in the states it reached", ""],
    ] as const) {
      await writeFile(manifest, JSON.stringify({ ...original, exploration: partial ? "partial" : "complete",
        graph: { trace: trace ? original.graph.trace : [], violations: violating ? { Safe: ["2"] } : {} } }));
      const { dom, errors } = runHtml(await readFile(writeHtml(manifest), "utf8"));
      try {
        const doc = dom.window.document;
        expect(errors).toEqual([]);
        expect(node(doc, "#title").textContent).toBe(sentence);
        expect(node(doc, "#summary-values").textContent).toContain(note);
        expect(node(doc, "#caveats").textContent).toBe(`${partial ? "Partial exploration: counts are at least these numbers. " : ""}Arrows between groups are possible moves, not one run. Only the failing run is a real execution.`);
        expect(node<HTMLButtonElement>(doc, "#trace-toggle").disabled).toBe(!trace);
        if (!trace) {
          const first = node<HTMLSelectElement>(doc, "#first");
          first.value = "x"; first.dispatchEvent(new dom.window.Event("change"));
          const cy = node<HTMLElement & { _cyreg: { cy: Core } }>(doc, "#graph")._cyreg.cy;
          expect(cy.nodes(".start")).toHaveLength(0); // layout seeds must not invent initialization
          expect(new Set(cy.nodes().map(n => (n.scratch("breadthfirst") as { depth: number }).depth)).size).toBe(2);
          expect(cy.nodes()[0]?.data("label")).toContain(partial ? "≥1 state" : "1 state");
        }
      } finally { dom.window.close(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps readable text in nodes and a separate panel, and exports PNG through the canvas API", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-controls-"));
  try {
    const { dom, errors } = runHtml(await readFile(writeHtml(await fixture(root)), "utf8"));
    try {
      const doc = dom.window.document;
      const cy = node<HTMLElement & { _cyreg: { cy: Core } }>(doc, "#graph")._cyreg.cy;
      expect(cy.nodes()).toHaveLength(1); // violating members do not become a child box
      expect(cy.nodes()[0]?.data("label")).toContain("≥2 states\n⚠ breaks Safe · ≥1 state");
      expect(cy.nodes()[0]?.style("shape")).toBe("round-rectangle");
      expect(cy.nodes()[0]?.style("text-valign")).toBe("center");
      expect(cy.nodes()[0]?.data("label")).toContain(attack.trim());
      cy.nodes()[0]?.emit("tap");
      expect(node(doc, "#details h2").textContent).toBe("Selected group");
      expect(node(doc, "#details dd").textContent).toBe(attack.trim());
      expect(node(doc, "#details button").textContent).toBe("Show its 2 states");
      expect(doc.querySelector("img")).toBeNull();
      expect(cy.edges()[0]?.data("label")).toBe(attack); // no ×1, even on a partial capture
      expect(cy.edges()[0]?.style("text-background-opacity")).toBe("1");
      expect(cy.edges()[0]?.style("text-background-color")).toBe("rgb(238,233,226)");
      const css = doc.querySelector("style")?.textContent ?? "";
      expect(css).toContain("height:100dvh");
      expect(css).toContain("grid-template-columns:minmax(0,1fr) minmax(260px,340px)");
      expect(node(doc, "#panel").contains(node(doc, "#groups"))).toBe(true);
      const positions = cy.nodes().map(n => ({ ...n.position() }));
      node<HTMLButtonElement>(doc, "#panel-toggle").click();
      expect(node<HTMLElement>(doc, "#panel").hidden).toBe(true);
      expect(cy.nodes().map(n => n.position())).toEqual(positions);
      node<HTMLButtonElement>(doc, "#panel-toggle").click();
      expect(node<HTMLElement>(doc, "#panel").hidden).toBe(false);
      expect(cy.nodes().map(n => n.position())).toEqual(positions);
      const exports: unknown[] = [], downloads: string[] = [];
      const blob = new dom.window.Blob(["png"], { type: "image/png" });
      cy.png = ((options: unknown) => { exports.push(options); return blob; }) as typeof cy.png;
      dom.window.URL.createObjectURL = value => { expect(value).toBe(blob); return "blob:viewer-export"; };
      dom.window.URL.revokeObjectURL = () => {};
      dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download, this.href); };
      node<HTMLButtonElement>(doc, "#download-png").click();
      expect(exports).toEqual([{ output: "blob", full: true, scale: 2, bg: "#faf8f4" }]);
      expect(downloads).toEqual(["__script__img_onerror_alert_1_______.png", "blob:viewer-export"]);
      expect(errors).toEqual([]);
    } finally { dom.window.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("shows verbatim rule text safely beside every broken-rule presentation and keeps group marks in a row", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-rule-"));
  try {
    const manifest = await fixture(root);
    const data = JSON.parse(await readFile(manifest, "utf8"));
    const definition = 'x = 0 => label = "</script>" /\\ x = 1';
    await writeFile(manifest, JSON.stringify({ ...data, binding: { ...data.binding, modelHash: "bound" },
      ruleDefinitions: { modelHash: "bound", properties: { Safe: definition } } }));
    const { dom, errors } = runHtml(await readFile(writeHtml(manifest), "utf8"));
    try {
      const doc = dom.window.document;
      expect(node(doc, "#summary-rules code").textContent).toBe(definition);
      expect(node(doc, "#summary-rules").textContent).toBe(`Rule, from the model: ${definition}`);
      expect(node(doc, "#explainer").textContent).toBe("TLC, the model checker, tried every order of the model's actions it could reach. Each box is a situation the system can be in, called a state.");
      expect([...doc.querySelectorAll(".legend p")].slice(0, 4).map(p => p.textContent)).toEqual([
        "Box: a situation (state) · start: where it begins", "Arrow: a possible move, not a story",
        "⚠: breaks a rule", "Highlighted path: the failing run, a real story",
      ]);
      const cy = node<HTMLElement & { _cyreg: { cy: Core } }>(doc, "#graph")._cyreg.cy;
      expect(cy.nodes()[0]?.data("label")).toContain(`Rule, from the model: ${definition}`);
      const row = node(doc, "#groups > div");
      expect(row.classList.contains("group-row")).toBe(true);
      expect(row.querySelector(":scope > .break")?.textContent).toContain("⚠ breaks Safe");
      expect(row.querySelector("code")?.textContent).toBe(definition);
      node<HTMLButtonElement>(doc, "#trace-toggle").click();
      expect(node(doc, "#trace .rule-definition code").textContent).toBe(definition);
      node<HTMLButtonElement>(doc, ".trace-step:last-of-type").click();
      expect(node(doc, "#details .rule-definition code").textContent).toBe(definition);
      expect(doc.querySelector("img")).toBeNull();
      expect(doc.querySelectorAll("script")).toHaveLength(2);
      expect(errors).toEqual([]);
    } finally { dom.window.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("never invents definition text from inherited object properties", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-html-no-rule-"));
  try {
    const manifest = await fixture(root);
    const data = JSON.parse(await readFile(manifest, "utf8"));
    data.graph.violations = { toString: ["2"] };
    await writeFile(manifest, JSON.stringify(data));
    const { dom, errors } = runHtml(await readFile(writeHtml(manifest), "utf8"));
    try {
      expect(node(dom.window.document, "#title").textContent).toContain("breaks toString");
      expect(dom.window.document.querySelectorAll(".rule-definition")).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally { dom.window.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
