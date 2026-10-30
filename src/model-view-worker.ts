import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { graphContentHash, graphLimits, reachedGraph, type TraceState } from "./model-graph.js";
import { buildChart, captureReading, chartLines, chartMermaid, loadReading, type ModelChart, type ReadingTrust } from "./model-chart.js";
import { buildModelView, type ModelView, type ViewRequest } from "./model-view.js";

/** The chart, when there is one, leads the plain text; TLC's graph follows unchanged. */
function withChart(view: ModelView, chart: ModelChart | undefined): ModelView {
  return chart === undefined ? view : { ...view, chart, plain: `${chartLines(chart).map(line => line.text).join("\n")}\n\n${view.plain}` };
}

type HtmlInput = Parameters<typeof import("./model-html.js").writeModelHtml>[1];

/** The page carries the chart as Mermaid for Pele to draw, when there is one. */
async function writeHtml(manifest: string, input: Omit<HtmlInput, "chart">, chart: ModelChart | undefined): Promise<unknown> {
  const { writeModelHtml } = await import("./model-html.js");
  return writeModelHtml(manifest, { ...input, ...chart === undefined ? {} : { chart: chartMermaid(chart, "LR") } });
}

/** Only loaded in the disposable process, never by the shell; a chart reading runs only if `trusted` says the operator trusts it. */
export async function modelViewWorker(trusted: ReadingTrust): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const { manifest, request, html } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { manifest: string; request: ViewRequest; html?: boolean };
  if ((await stat(manifest)).size > 32 * 1024 * 1024) throw new Error("Manifest exceeds viewer budget");
  const data = JSON.parse(await readFile(manifest, "utf8")) as {
    version: number; status: string; exploration: string; header?: string; binding?: { root?: string; model?: string; modelHash?: string };
    ruleDefinitions?: { modelHash: string; properties: Record<string, string> };
    artifacts: { dot: { file: string; sha256: string } };
    graph: { trace: TraceState[]; violations: Record<string, string[]> };
  };
  if (data.version !== 1 || data.status !== "captured" || !["partial", "complete"].includes(data.exploration)) throw new Error("Graph unavailable");
  const artifact = data.artifacts.dot;
  if (basename(artifact.file) !== artifact.file) throw new Error("DOT must be beside the session");
  const dotPath = join(dirname(manifest), artifact.file);
  if ((await stat(dotPath)).size > graphLimits.bytes) throw new Error("DOT exceeds viewer budget");
  const dot = await readFile(dotPath, "utf8");
  if (graphContentHash(dot) !== artifact.sha256) throw new Error("DOT content hash mismatch");
  const graph = reachedGraph(dot);
  if (graph.states.length > graphLimits.states || graph.edges.length > graphLimits.edges) throw new Error("Graph exceeds viewer budget");
  const reports = { ...data.graph, ruleDefinitions: data.ruleDefinitions !== undefined && data.ruleDefinitions.modelHash === data.binding?.modelHash
    ? data.ruleDefinitions.properties : {} };
  const partial = data.exploration === "partial", header = data.header ?? "";
  const { root, model } = captureReading(data.binding, manifest);
  const chart = request.chart === true || html === true ? buildChart(graph, reports, partial, header, await loadReading(root, model, trusted)) : undefined;
  const view = withChart(buildModelView(graph, reports, partial, header, request), chart);
  const result = JSON.stringify(html === true ? await writeHtml(manifest, { model, graph, reports, header, view }, chart) : view);
  // main exits explicitly: wait until the pipe owns every byte, including on Windows.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(result, error => { if (error) reject(error); else resolve(); });
  });
}
