import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { captureGraph } from "../src/model-graph.js";
import { defaultProjection, adjacentViolation, buildModelView } from "../src/model-view.js";
import { loadModelView } from "../src/model-view-process.js";
import { conservesCounts } from "../src/verification/group-count-rule.js";

it("rejects a regrouping that loses any member, violation or edge multiplicity", () => {
  expect(conservesCounts([1, 1, 1], [1, 0, 1], [1, 1, 1], [2, 1], [1, 1], [3])).toBe(true);
  expect(conservesCounts([3], [2], [3], [2], [2], [3])).toBe(false);
  expect(conservesCounts([3], [2], [3], [3], [1], [3])).toBe(false);
  expect(conservesCounts([3], [2], [3], [3], [2], [2])).toBe(false);
});

it("projects only reached groups, conserves counts, marks any bad member and stops its worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-view-"));
  try {
    const dot = join(root, "input.dot");
    await writeFile(dot, 'digraph {\n1 [label="/\\\\ pc = \\"a\\"\\n/\\\\ x = 0"]\n2 [label="/\\\\ pc = \\"a\\"\\n/\\\\ x = 1"]\n3 [label="/\\\\ pc = \\"b\\"\\n/\\\\ x = 1"]\n1 -> 2 [label="Go"]\n2 -> 3 [label="Go"]\n3 -> 3 [label="Stay"]\n}');
    const capture = await captureGraph(dot, 'Error: Invariant Safe is violated.\nState 1: <Init>\n/\\ pc = "a"\n/\\ x = 0\n\nState 2: <Go>\n/\\ pc = "a"\n/\\ x = 1\n\n3 distinct states found', {
      root, command: [], startedAt: "", finishedAt: "", processEnded: "exited", evidenceOutputHash: "", sessionFile: join(root, "s.jsonl"), model: "missing.tla", config: "", modelHash: "", configHash: "", effectiveConfigHash: "", evidenceHash: "", exitCode: 12,
    }, { sessionFile: join(root, "s.jsonl") });
    expect(capture.status).toBe("captured");
    const view = await loadModelView(capture.manifest ?? "", {}, new AbortController().signal);
    expect(view.workerPid).not.toBe(process.pid);
    expect(() => process.kill(view.workerPid, 0)).toThrow();
    expect(view.projection).toEqual(["pc"]);
    expect(view.groups.map(g => [g.members.length, g.violating])).toEqual([[2, 1], [1, 0]]);
    expect(view.edges.reduce((n, e) => n + e.count, 0)).toBe(3);
    expect(view.plain).toContain("! BREAK >=1");
    expect(view.plain).toContain("lower bounds");
    expect(view.plain).toContain("not an execution");
    expect(view.plain).not.toMatch(/(?:zero|0) reports (?:mean|establish|prove) (?:the model is )?safe/iu);
    expect(view.plain).toContain("zero reports do not establish safety");
    expect(view.plain).toContain("Safe");
    const drilled = await loadModelView(capture.manifest ?? "", { members: view.groups[0]?.members ?? [], projection: [], search: "x = 1" }, new AbortController().signal);
    expect(drilled.states).toHaveLength(2);
    expect(drilled.matches).toEqual(["2"]);
    expect(drilled.trace.map(s => s.fingerprint)).toEqual(["1", "2"]);
    expect(drilled.states[1]?.variables).toEqual({ pc: '"a"', x: "1" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects report fingerprints outside the captured graph rather than dropping violations", () => {
  const graph = { states: [{ fingerprint: "1", valuation: "/\\ x = 1" }], edges: [] };
  expect(() => buildModelView(graph, { trace: [], violations: { Safe: ["missing"] } }, false, "", {})).toThrow(/report/u);
});

it("chooses the ordered header projection, then pc, then minimum nonconstant cardinality", () => {
  const graph = { states: [0, 1, 2].map(n => ({ fingerprint: String(n), valuation: `/\\ pc = "a"\n/\\ x = ${n}\n/\\ y = ${n % 2}` })), edges: [] };
  const view = buildModelView(graph, { trace: [], violations: {} }, false, "", {});
  expect(defaultProjection(view.states, "(*\n @view groupBy: y, x   (viewer directive)\n*)")).toEqual(["y", "x"]);
  expect(defaultProjection(view.states, "")).toEqual(["pc"]);
  expect(defaultProjection(view.states.map(s => ({ ...s, variables: { x: s.variables["x"] ?? "", y: s.variables["y"] ?? "" } })), "")).toEqual(["y"]);
  expect(adjacentViolation({ ...view, violations: ["2", "1"] }, undefined, -1)).toBe("1");
  expect(adjacentViolation({ ...view, violations: ["2", "1"] }, "1", 1)).toBe("2");
});

it("conserves the real continued 320-state graph under every ordered projection", async () => {
  const { existsSync } = await import("node:fs");
  const operator = JSON.parse(process.env["TESOTA_TEST_OPERATOR_HOME"] ?? "{}") as { HOME?: string; USERPROFILE?: string };
  const jar = join(operator.USERPROFILE ?? operator.HOME ?? "", ".tesota", "tools", "tla2tools.jar");
  expect(existsSync(jar), "real TLC is required for this acceptance test").toBe(true);
  const { runProcess } = await import("../src/process.js");
  const { readFile, copyFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "tesota-view-tlc-"));
  try {
    for (const ext of ["tla", "cfg"]) await copyFile(new URL(`./fixtures/model-view/HostSessions.${ext}`, import.meta.url), join(root, `HostSessions.${ext}`));
    const chunks: Buffer[] = [];
    const run = await runProcess("java", ["-cp", jar, "tlc2.TLC", "-workers", "1", "-continue", "-dump", "dot,actionlabels", "reached.dot", "HostSessions"], root, new AbortController().signal, 60_000, chunk => chunks.push(chunk));
    expect(run.exitCode).toBe(0);
    const output = Buffer.concat(chunks).toString("utf8");
    const capture = await captureGraph(join(root, "reached.dot"), output, {
      root, command: [], startedAt: "", finishedAt: "", processEnded: "exited", evidenceOutputHash: "", sessionFile: join(root, "s.jsonl"), model: "HostSessions.tla", config: "HostSessions.cfg", modelHash: "", configHash: "", effectiveConfigHash: "", evidenceHash: "", exitCode: 0,
    }, { sessionFile: join(root, "s.jsonl"), continue: true });
    expect(capture.status).toBe("captured");
    const manifest = capture.manifest ?? "";
    const view = await loadModelView(manifest, {}, new AbortController().signal);
    expect(view.states).toHaveLength(320);
    expect(view.projection).toEqual(["host", "session"]);
    expect(view.partial).toBe(false);
    expect(view.violations).toHaveLength(60);
    const data = JSON.parse(await readFile(manifest, "utf8"));
    const projections = [[], ...view.variables.map(k => [k]), ...view.variables.flatMap(a => view.variables.filter(b => b !== a).map(b => [a, b]))];
    for (const projection of projections) {
      const grouped = buildModelView(data.graph, data.graph, false, "", { projection });
      expect(grouped.groups.reduce((n, g) => n + g.members.length, 0)).toBe(320);
      expect(grouped.groups.reduce((n, g) => n + g.violating, 0)).toBe(60);
      expect(grouped.edges.reduce((n, e) => n + e.count, 0)).toBe(data.counts.edges);
      expect(new Set(grouped.groups.flatMap(g => g.members)).size).toBe(320);
      for (const group of grouped.groups) {
        expect(group.members.length).toBeGreaterThan(0);
        expect(grouped.plain.split("Full reached states:")[0]?.includes(`${group.id}: ${group.members.length} members ! BREAK`)).toBe(group.violating > 0);
      }
    }
    // Abort after this real worker starts returning a large model, not before spawn.
    const { fileURLToPath } = await import("node:url");
    const entry = fileURLToPath(new URL("../packages/core/src/main.ts", import.meta.url));
    const active = new AbortController();
    let workerPid = 0;
    const stopped = await runProcess("bun", [entry, "__model-view"], root, active.signal, 30_000, undefined, {
      input: JSON.stringify({ manifest, request: {} }), onStdout: chunk => {
        const pid = /"workerPid":(\d+)/u.exec(chunk.toString("utf8"))?.[1];
        if (pid !== undefined) { workerPid = Number(pid); active.abort(); }
      },
    });
    expect(workerPid).toBeGreaterThan(0);
    expect(stopped.ended).toBe("cancelled");
    expect(() => process.kill(workerPid, 0)).toThrow();
    const plainChunks: Buffer[] = [];
    const plain = await runProcess("bun", [entry, "graph", "--plain", manifest], root, new AbortController().signal, 30_000, undefined,
      { onStdout: chunk => plainChunks.push(chunk) });
    expect(plain.exitCode).toBe(0);
    expect(Buffer.concat(plainChunks).toString("utf8")).toBe(`${view.plain}\n`);
    expect(plain.stdout).toContain("reported violating 60");
    expect(plain.stdout).toContain("! BREAK");
    const cancelled = new AbortController(); cancelled.abort();
    await expect(loadModelView(manifest, {}, cancelled.signal)).rejects.toThrow(/cancelled/u);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
