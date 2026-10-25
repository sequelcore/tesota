import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import { captureGraph, type GraphCapture } from "../src/model-graph.js";
import { graphPreviewRows } from "../src/messages.js";
import { entryGraphs, sessionGraphs } from "../src/receipt.js";

const failure = "\nError: Invariant Safe is violated.\nError: The behavior up to this point is:\nState 1: <Initial predicate>\nx = 0\n\nState 2: <Next>\nx = 1\n\n";

async function captured(output = "Model checking completed.\n9 distinct states found", trace = ""): Promise<GraphCapture> {
  const root = await mkdtemp(join(tmpdir(), "tesota-preview-"));
  try {
    const dot = join(root, "graph.dot");
    await writeFile(dot, Array.from({ length: 9 }, (_, k) => `${100 + k} [label="x = ${k}"]\n${100 + k} -> ${100 + (k + 1) % 9} [label="Next"]`).join("\n"));
    return await captureGraph(dot, output + trace, { root, command: [], startedAt: "", finishedAt: "", processEnded: "exited",
      evidenceOutputHash: "", sessionFile: join(root, "session.jsonl"), model: "Counter.tla", config: "Counter.cfg",
      modelHash: "", configHash: "", effectiveConfigHash: "", evidenceHash: "", exitCode: 0 }, { sessionFile: join(root, "session.jsonl") });
  } finally { await rm(root, { recursive: true, force: true }); }
}

it("draws a failing run as its concrete counterexample, not the reached ring", async () => {
  const rows = graphPreviewRows(await captured("9 distinct states found", failure), 80);
  expect(rows.join("\n")).toContain("Counterexample path");
  expect(rows.filter((row) => row.startsWith("| "))).toEqual(["| 1 -> !2"]);
  expect(rows.join("\n")).not.toContain("9 -> 1");
});

it("labels stopped exploration partial and every count a lower bound", async () => {
  const rows = graphPreviewRows(await captured("9 distinct states found"), 80).join("\n");
  expect(rows).toContain("Partial exploration; counts are lower bounds");
  expect(rows).toContain(">=9 reached");
  expect(rows).toContain(">=0 reported violating (not a safety verdict)");
});

it("reports absent, failed, limited and unavailable captures in one line", () => {
  expect(graphPreviewRows(undefined, 80)).toEqual(["Graph unavailable: no capture"]);
  for (const status of ["failed", "limited", "unavailable"] as const) {
    expect(graphPreviewRows({ status, reason: "capture reason" }, 80)).toEqual([`Graph ${status}: capture reason`]);
  }
});

it("keeps narrow previews within width without clipping counts or hiding omissions", async () => {
  const capture = await captured();
  for (const width of [32, 20, 10]) {
    const rows = graphPreviewRows(capture, width);
    expect(rows.every((row) => row.length <= width)).toBe(true);
    expect(rows.filter((row) => row.startsWith("| ")).length).toBeLessThanOrEqual(6);
    expect(rows.join(" ")).toContain("9 reached");
  }
  expect(graphPreviewRows(capture, 32).filter((row) => row.startsWith("| ")).join(" ")).toContain("9 -> 1");
});

it("draws the whole nine-state graph in at most six diagram rows", async () => {
  const rows = graphPreviewRows(await captured(), 80);
  expect(rows.join("\n")).toContain("9 reached");
  expect(rows.join("\n")).toContain("0 reported violating (not a safety verdict)");
  const diagram = rows.filter((row) => row.startsWith("| "));
  expect(diagram.length).toBeGreaterThan(0);
  expect(diagram.length).toBeLessThanOrEqual(6);
  expect(diagram.join(" ")).toContain("9 -> 1");
  expect(rows.join("\n")).toContain("Open graph");
  expect(rows.join("\n")).toContain("beside the session");
  for (const ext of [".dot", ".mmd", ".txt"]) expect(rows.join("\n")).toContain(ext);
});

it("names /graph with the capture's stem, and finds a session's graphs newest receipt first", async () => {
  const capture = await captured();
  const name = basename(capture.status === "captured" ? capture.manifest : "").replace(/\.manifest\.json$/u, "");
  expect(graphPreviewRows(capture, 200)).toContain(`Open graph: /graph ${name}`);
  const entry = (subject: string) => ({ type: "custom_message", customType: "tesota-receipt-graphs", details: { receipt: {}, graphs: [{ subject, capture }] } });
  expect(entryGraphs([entry("old"), { type: "custom_message", customType: "tesota-receipt", details: {} }, entry("new")]).map((graph) => graph.subject))
    .toEqual(["new", "old"]);
});

it("finds a graph a model check captured without a receipt carrying it, as a read-only or print-mode run leaves it, each capture once", async () => {
  const capture = await captured();
  const other = await captured();
  const check = (path: string, from: GraphCapture) => ({ role: "toolResult", toolName: "check_model", details: { path, capture: from } });
  const receipt = { role: "custom", customType: "tesota-receipt-graphs", details: { receipt: {}, graphs: [{ subject: "models/A.tla", capture }] } };
  // A read-only request ends without a receipt: only the check's result holds the capture.
  expect(sessionGraphs([check("models/A.tla", capture)]).map((graph) => graph.subject)).toEqual(["models/A.tla"]);
  // A receipt carrying the same capture names it once; a later check comes first.
  expect(sessionGraphs([check("models/A.tla", capture), receipt, check("models/B.tla", other)]).map((graph) => graph.subject))
    .toEqual(["models/B.tla", "models/A.tla"]);
  expect(sessionGraphs([{ role: "toolResult", toolName: "read", details: { path: "a", capture } }, { role: "toolResult", toolName: "check_model", details: null }]))
    .toEqual([]);
});
