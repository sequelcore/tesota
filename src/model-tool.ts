import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Theme, ToolDefinition, ToolResult } from "./contract.js";
import { type TObject, type TString, Type } from "typebox";
import { quietOutput } from "./evidence.js";
import { bold, expandHint, Rows, spread, wrapUnder } from "./messages.js";
import { READING_FORMAT, readingPath } from "./model-chart.js";
import { checkModel, HEADER_FORMAT, type ModelCheck, modelHeader, modelReport, tlaToolsJar } from "./model-check.js";
import { linkWords, modelHolds, modelWhy } from "./receipt.js";

/**
 * The working agent's own model check (#554): TLC on one TLA+ or Quint model
 * it is working on, through the gate's own check (`checkModel`), so it sees a
 * counterexample while it works. Without it, pstack's
 * `/create-formal-verification-skill` judged TLC unavailable and wrote a
 * JavaScript interleaving test instead of a model.
 */

/** Whether Tesota finds TLC (`tlaToolsJar`), which turns on `check_model` and its guidance. */
export function hasTlc(): boolean {
  return existsSync(tlaToolsJar());
}

/** How the agent should use `check_model`: what TLC is for, where a model goes, and its header. */
export const MODEL_GUIDELINES: readonly string[] = [
  "TLC is installed, so a design whose steps interleave, such as concurrent or distributed code, can be model-checked: " +
    "write a TLA+ model (a .tla with its .cfg beside it, such as under models/) or a Quint model (.qnt) in the project, " +
    "run check_model on it while you work, and work until it passes. Tesota checks it again before the run settles, " +
    "and on every later request that changes it or the code it covers.",
  `Start the model with this header in a comment, paths from the project root:\n${HEADER_FORMAT}`,
  "A fault is a separate variant that plants a bug and must break an invariant, such as another .cfg with the lock " +
    "removed; never the model or its own .cfg.",
  "A counterexample comes back as numbered steps in the model's names: if every step can happen in the code, fix the " +
    "code; if one cannot, fix the model. Never weaken an invariant or the model to make it pass.",
  ...process.platform === "win32" ? ["On Windows Quint cannot start Apalache, which it needs to run TLC, so write the model in TLA+."] : [],
];

/**
 * A model's check for the agent: what a pass establishes and what it does
 * not, why it did not run, or what the gate would send back (`modelReport`).
 */
/** A captured model without a reading is asked for one once per check, as a model without a header is given the header (#761). */
function readingAsk(root: string, model: string): string {
  const reading = readingPath(model);
  return existsSync(resolve(root, reading)) ? ""
    : `\n\n/graph opens on a chart of this graph. To label its states and steps in the user's words, write ${reading}:\n\n${READING_FORMAT}`;
}

export function modelToolReport(check: ModelCheck): string {
  if (check.evidence.outcome === "passed") {
    return `Model-checked: ${modelHolds(check)}; ${linkWords[check.link]}.\n\n${check.evidence.limits}`;
  }
  if (check.run === "not_started" || check.run === "timed_out" || check.run === "cancelled") {
    return `Not model-checked: ${modelWhy(check).replace(/\.$/u, "")}. This says nothing about the model.`;
  }
  return `${modelReport(check)}\n\nThen run check_model again.`;
}

function text(content: string): ToolResult<ModelCheck | undefined> {
  return { content: [{ type: "text", text: content }], details: undefined, isError: true };
}

/** `check_model` and its model, with how long the check took at the right once it has run. */
function renderCall(args: { path?: string }, theme: Theme, context: { readonly durationMs: number | undefined }): Rows {
  const title = `${theme.fg("toolTitle", bold("check_model"))} ${theme.fg("accent", args.path ?? "")}`;
  return new Rows((width) => [context.durationMs === undefined ? title
    : spread(title, theme.fg("dim", `${(context.durationMs / 1000).toFixed(1)}s`), width)]);
}

/** A check's result in a few words, the receipt's; what TLC printed when expanded. */
function renderResult(result: ToolResult<ModelCheck | undefined>, options: { expanded: boolean; isPartial: boolean },
  theme: Theme): Rows {
  return new Rows((width) => {
    if (options.isPartial) return ["", theme.fg("accent", "◐ checking…")];
    const check = result.details;
    const lines = result.content.flatMap((part) => part.type === "text" ? part.text.split("\n") : []);
    if (check === undefined) return ["", ...lines.flatMap((line) => wrapUnder(theme.fg("toolOutput", line), width, 0))];
    const passed = check.evidence.outcome === "passed";
    const head = passed ? `${theme.fg("success", "✓ Model-checked")}${theme.fg("muted", ` — ${modelHolds(check)}`)}`
      : `${theme.fg("error", "✗ Not model-checked")}${theme.fg("muted", ` — ${check.counterexample?.violation ?? lines[0] ?? ""}`)}`;
    const output = quietOutput(check.evidence.output);
    return ["", ...wrapUnder(head, width, 2),
      ...options.expanded ? ["", ...output.flatMap((line) => wrapUnder(theme.fg("toolOutput", line), width, 2))]
        : passed || output.length === 0 ? [] : ["", expandHint(theme, "for TLC's output")]];
  });
}

const parameters: TObject<{ path: TString }> = Type.Object({ path: Type.String({ description: "The .tla or .qnt model to check, relative to the project" }) });

/**
 * `check_model`, inactive until the extension finds TLC (`hasTlc`). It runs
 * alone, since the evidence must describe the model and its code as no other
 * tool call left them mid-check.
 */
export const modelTool: ToolDefinition<typeof parameters, ModelCheck | undefined> = {
  name: "check_model", label: "Check model",
  description: "Check a TLA+ or Quint model with TLC, as Tesota's gate does: its tesota-model header, its invariants " +
    "in every reachable state, then each planted fault, which must break one. Reports the counterexample as numbered steps.",
  promptSnippet: "Model-check a TLA+ or Quint model with TLC, which is installed, and its planted faults",
  promptGuidelines: [...MODEL_GUIDELINES],
  parameters,
  defaultActive: false,
  executionMode: "sequential",
  execute: async (_id, params, signal, _update, ctx) => {
    const absolute = resolve(ctx.cwd, params.path.replace(/^@/u, ""));
    const path = relative(ctx.cwd, absolute).split("\\").join("/");
    if (path === "" || path.startsWith("../") || isAbsolute(path)) {
      return text(`${params.path} is outside the project; check_model checks models inside it.`);
    }
    if (!path.endsWith(".tla") && !path.endsWith(".qnt")) return text(`${path} is not a model; check_model checks .tla and .qnt files.`);
    let source: string;
    try { source = await readFile(absolute, "utf8"); } catch { return text(`${path} does not exist.`); }
    if (modelHeader(source) === undefined) {
      return text(`${path} has no tesota-model header, so it is no model Tesota checks. Start it with:\n\n${HEADER_FORMAT}`);
    }
    const check = await checkModel(ctx.cwd, path, [], signal ?? new AbortController().signal, undefined, undefined, ctx.env,
      ctx.sessionFile === undefined ? undefined : { sessionFile: ctx.sessionFile });
    const artifacts = ctx.sessionFile === undefined ? "" : check.capture?.manifest === undefined
      ? `\n\nGraph capture: ${check.capture?.status ?? "unavailable"}. ${check.capture?.status === "captured" ? "" : check.capture?.reason ?? ""}`
      : `\n\nVerification artifacts beside the session file: ${check.capture.manifest}${readingAsk(ctx.cwd, path)}`;
    return { content: [{ type: "text", text: `${modelToolReport(check)}${artifacts}` }], details: check,
      ...check.evidence.outcome === "passed" ? {} : { isError: true } };
  },
  renderCall,
  renderResult,
};
