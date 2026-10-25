import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { graphContentHash, graphLimits, reachedGraph, type TraceState } from "./model-graph.js";
import { buildModelView, type ViewRequest } from "./model-view.js";

/** Only loaded in the disposable process, never by the shell. */
export async function modelViewWorker(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const { manifest, request, html } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { manifest: string; request: ViewRequest; html?: boolean };
  if ((await stat(manifest)).size > 32 * 1024 * 1024) throw new Error("Manifest exceeds viewer budget");
  const data = JSON.parse(await readFile(manifest, "utf8")) as {
    version: number; status: string; exploration: string; header?: string; binding?: { model?: string };
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
  const view = buildModelView(graph, data.graph, data.exploration === "partial", data.header ?? "", request);
  const result = html === true
    ? JSON.stringify(await (await import("./model-html.js")).writeModelHtml(manifest, {
      model: data.binding?.model ?? basename(manifest), graph, reports: data.graph, header: data.header ?? "", view,
    }))
    : JSON.stringify(view);
  // main exits explicitly: wait until the pipe owns every byte, including on Windows.
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(result, error => { if (error) reject(error); else resolve(); });
  });
}
