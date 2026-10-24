import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** Capture bounds never constrain TLC's exploration or its verdict. */
export const graphLimits: { readonly bytes: number; readonly states: number; readonly edges: number } = { bytes: 16 * 1024 * 1024, states: 10_000, edges: 50_000 };
export interface GraphOptions {
  readonly sessionFile: string;
  readonly continue?: boolean;
  readonly limits?: { readonly bytes: number; readonly states: number; readonly edges: number };
}
/** Bounded transcript data prepared at capture time; drawing never reads or lays out the full manifest. */
export interface GraphPreview {
  readonly reached: number;
  readonly violating: number;
  readonly partial: boolean;
  readonly kind: "graph" | "trace";
  readonly entries: readonly string[];
  readonly omitted: boolean;
}
export type GraphCapture = { readonly status: "captured"; readonly manifest: string; readonly preview?: GraphPreview }
  | { readonly status: "failed" | "limited" | "unavailable"; readonly reason: string; readonly manifest?: string };
export interface GraphState { readonly fingerprint: string; readonly valuation: string; }
export interface GraphEdge { readonly from: string; readonly to: string; readonly action: string; }
export interface TraceState { readonly fingerprint: string; readonly action: string; readonly valuation: string; }
export interface ReachedGraph { readonly states: GraphState[]; readonly edges: GraphEdge[]; }

/** TLC state assignments, including multiline records, sets, tuples and functions. */
export function stateVariables(lines: readonly string[]): Map<string, string> {
  const variables = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines) {
    const assignment = /^(?:\/\\\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/u.exec(line.trim());
    if (assignment !== null && (line.trimStart().startsWith("/\\") || variables.size === 0)) {
      current = assignment[1] ?? "";
      variables.set(current, assignment[2] ?? "");
    } else if (current !== undefined && line.trim() !== "") {
      variables.set(current, `${variables.get(current) ?? ""} ${line.trim()}`);
    }
  }
  return variables;
}

function valuationKey(valuation: string): string {
  return JSON.stringify([...stateVariables(valuation.split(/\r?\n/u))].sort(([a], [b]) => a.localeCompare(b)));
}

/** A property is associated only with the terminal valuation of its own TLC invariant report. */
function invariantReports(output: string, graph: ReachedGraph): { trace: TraceState[]; violations: Record<string, string[]> } {
  const byValue = new Map(graph.states.map((state) => [valuationKey(state.valuation), state.fingerprint]));
  const violations: Record<string, string[]> = {};
  let trace: TraceState[] = [];
  for (const report of output.matchAll(/Error: Invariant (\w+) is violated(\.| by the initial state:)([\s\S]*?)(?=Error: Invariant|\d[\d,]* states generated|$)/gu)) {
    const steps: TraceState[] = [];
    if (report[2] !== ".") {
      const valuation = (report[3] ?? "").trimStart().split(/\r?\n\r?\n/u)[0]?.trim() ?? "";
      const fingerprint = byValue.get(valuationKey(valuation));
      if (fingerprint === undefined) throw new Error("TLC violating initial valuation missing from graph");
      steps.push({ fingerprint, action: "Initial predicate", valuation });
    }
    for (const state of (report[3] ?? "").matchAll(/State \d+: <([^\r\n]+)>\r?\n([\s\S]*?)(?=\r?\n\r?\n|$)/gu)) {
      const valuation = (state[2] ?? "").trim();
      const fingerprint = byValue.get(valuationKey(valuation));
      if (fingerprint === undefined) throw new Error("TLC trace valuation missing from reached graph");
      steps.push({ fingerprint, action: state[1] ?? "", valuation });
    }
    const bad = steps.at(-1);
    if (bad === undefined) throw new Error("TLC invariant report has no supported state trace");
    const property = report[1] ?? "";
    const members = violations[property] ?? [];
    if (!members.includes(bad.fingerprint)) members.push(bad.fingerprint);
    violations[property] = members;
    if (trace.length === 0) trace = steps;
  }
  return { trace, violations };
}
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

/** TLC's DOT labels carry the full valuation, not a scalar-only variable subset. */
export function reachedGraph(dot: string): ReachedGraph {
  const states = [...dot.matchAll(/^(-?\d+) \[label="((?:[^"\\]|\\.)*)"/gmu)].map((match) => ({
    fingerprint: match[1] ?? "", valuation: JSON.parse(`"${match[2] ?? ""}"`) as string,
  }));
  const edges = [...dot.matchAll(/^(-?\d+) -> (-?\d+) \[label="((?:[^"\\]|\\.)*)"/gmu)].map((match) => ({
    from: match[1] ?? "", to: match[2] ?? "", action: JSON.parse(`"${match[3] ?? ""}"`) as string,
  }));
  const ids = new Set(states.map((state) => state.fingerprint));
  if (states.length === 0 || edges.some((edge) => !ids.has(edge.from) || !ids.has(edge.to))) throw new Error("Incomplete or unsupported TLC DOT graph");
  return { states, edges };
}

export interface GraphBinding {
  readonly root: string;
  readonly command: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly processEnded: string;
  readonly evidenceOutputHash: string;
  readonly sessionFile: string;
  readonly model: string;
  readonly config: string;
  readonly modelHash: string;
  readonly configHash: string;
  readonly effectiveConfigHash: string;
  readonly evidenceHash: string;
  readonly exitCode: number | null;
}

/** Publish only after TLC finishes, before its temporary directory is released. Failure is data, never a verification result. */
export async function captureGraph(dotFile: string, output: string, binding: GraphBinding, options: GraphOptions,
  outputComplete = true): Promise<GraphCapture> {
  const limits = options.limits ?? graphLimits;
  const stem = `${basename(binding.sessionFile)}.model-${randomUUID()}`;
  const directory = dirname(binding.sessionFile);
  const manifest = join(directory, `${stem}.manifest.json`);
  const metadata = { version: 1, binding: { ...binding, runId: stem, tlcVersion: output.match(/^TLC2 Version[^\r\n]*/mu)?.[0] ?? "unknown",
    continued: options.continue === true }, limits };
  const failure = async (status: "failed" | "limited" | "unavailable", reason: string): Promise<GraphCapture> => {
    try {
      await writeFile(manifest, JSON.stringify({ ...metadata, status, reason }, null, 2), { flag: "wx" });
      return { status, reason, manifest };
    } catch (error) { return { status, reason: `${reason}; manifest could not be written: ${String(error)}` }; }
  };
  try {
    if (!outputComplete || (await stat(dotFile)).size > limits.bytes || Buffer.byteLength(output) > limits.bytes) {
      return await failure("limited", "Graph or TLC output exceeds capture byte limit");
    }
    if ([...output.matchAll(/^Error: (.+)$/gmu)].some((error) => !/^Invariant \w+ is violated(?:\.| by the initial state:)|^The behavior up to this point is:/u.test(error[1] ?? ""))) {
      return await failure("unavailable", "Typed extraction is available only for invariant violations; other TLC errors, deadlocks and liveness are unavailable");
    }
    const dot = await readFile(dotFile, "utf8");
    const graph = reachedGraph(dot);
    if (graph.states.length > limits.states || graph.edges.length > limits.edges) return await failure("limited", "Graph exceeds capture state or edge limit");
    const reports = invariantReports(output, graph);
    const complete = /Model checking completed\./u.test(output);
    const reported = [...output.matchAll(/([\d,]+) distinct states? found/gu)].at(-1)?.[1];
    if (reported === undefined || Number(reported.replaceAll(",", "")) !== graph.states.length) throw new Error("DOT / TLC reached-state count mismatch");
    const counts = { kind: complete ? "exact" : "lower_bounds", reached: graph.states.length, edges: graph.edges.length,
      violating: new Set(Object.values(reports.violations).flat()).size };
    const ids = new Map(graph.states.map((state, index) => [state.fingerprint, `n${index + 1}`]));
    const texts = { dot, mmd: ["flowchart TD", ...graph.states.map((state) => `  ${ids.get(state.fingerprint)}["${ids.get(state.fingerprint)?.slice(1)}: ${state.fingerprint}"]`),
      ...graph.edges.map((edge) => `  ${ids.get(edge.from)} -->|${JSON.stringify(edge.action)}| ${ids.get(edge.to)}`)].join("\n"),
    txt: [`Exploration: ${complete ? "complete; exact counts" : "partial; counts are lower bounds"}`,
      `Reached: ${counts.reached}; edges: ${counts.edges}; reported violating states: ${counts.violating}`,
      ...graph.states.map((state, index) => `${index + 1}: ${state.fingerprint}\n${state.valuation}\n`),
      ...graph.edges.map((edge) => `${edge.from} -> ${edge.to}: ${edge.action}`), "", "TLC output:", output].join("\n") };
    const artifacts: Record<string, { file: string; sha256: string }> = {};
    for (const [extension, text] of Object.entries(texts)) {
      const file = `${stem}.${extension}`;
      await writeFile(join(directory, file), text, { flag: "wx" });
      artifacts[extension] = { file, sha256: hash(text) };
    }
    await writeFile(manifest, JSON.stringify({ ...metadata, status: "captured",
      header: await readFile(resolve(binding.root, binding.model), "utf8").catch(() => ""),
      exploration: complete ? "complete" : "partial", counts, graph: { ...graph, ...reports }, artifacts }, null, 2), { flag: "wx" });
    return { status: "captured", manifest, preview: transcriptGraph(graph, reports, counts, !complete) };
  } catch (error) { return failure("failed", String(error)); }
}

/** Small, presentation-only topology; complete valuations and action labels stay in the artifacts. */
function transcriptGraph(graph: ReachedGraph, reports: ReturnType<typeof invariantReports>,
  counts: { reached: number; violating: number }, partial: boolean): GraphPreview {
  const numbers = new Map(graph.states.map((state, index) => [state.fingerprint, index + 1]));
  const bad = new Set(Object.values(reports.violations).flat());
  const name = (id: string): string => `${bad.has(id) ? "!" : ""}${numbers.get(id)}`;
  const small = graph.states.length <= 24 && graph.edges.length <= 48;
  const entries = small ? graph.states.map((state) => {
    const next = [...new Set(graph.edges.filter((edge) => edge.from === state.fingerprint).map((edge) => name(edge.to)))];
    return `${name(state.fingerprint)}${next.length === 0 ? " (end)" : ` -> ${next.join(",")}`}`;
  }) : [];
  const trace = reports.trace.slice(0, 24).map((state) => name(state.fingerprint));
  return { reached: counts.reached, violating: counts.violating, partial, kind: trace.length > 0 ? "trace" : "graph",
    entries: trace.length > 0 ? trace : entries, omitted: trace.length > 0 ? reports.trace.length > trace.length : !small };
}

export const graphContentHash: (text: string) => string = hash;