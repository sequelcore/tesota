import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { numberedDiff } from "../diff-lines.js";
import type { Finding, ReviewInput, ReviewReport } from "../review.js";
import { type CodingTurnResult, CodingSession, type ModelAccess, readOnlyFileTools, repositoryInstructions,
  usageOption } from "./pi-coding-session.js";

/**
 * The fix validator (decision 016): after a correction round, a read-only
 * session checks whether each finding sent back is now resolved, instead of
 * reviewing the whole candidate again. Adapted from the read-only fix
 * validator in Gentle AI's review (MIT).
 */

const VALIDATOR = "Fix validation";

export type Resolution = "resolved" | "unresolved" | "undetermined";

export interface FixVerdict {
  readonly id: number;
  readonly verdict: Resolution;
  readonly evidence: string;
}

const resolutionSchema = Type.Object({ verdicts: Type.Array(Type.Object({
  id: Type.Integer({ minimum: 1, description: "The finding's number" }),
  verdict: Type.Union([Type.Literal("resolved"), Type.Literal("unresolved"), Type.Literal("undetermined")]),
  evidence: Type.String({ description: "The current code lines or check output that show it" }),
})) });

function recordResolutions(record: (verdicts: readonly FixVerdict[]) => void): ToolDefinition {
  return defineTool({ name: "record_resolutions", label: "Record resolutions",
    description: "Record one verdict per finding once you have checked them all. Call it exactly once.",
    parameters: resolutionSchema,
    execute: async (_id, value) => {
      record(value.verdicts);
      return { content: [{ type: "text", text: "Recorded." }], details: undefined, terminate: true };
    } });
}

function validatorPrompt(root: string): string {
  return "You are Tesota's fix validator. Each finding below was confirmed on an earlier result and sent back to " +
    "the agent that changed the code. Check the current code with the read, search and list tools and decide for " +
    "each one: resolved, only if the current code no longer has the problem, quoting the lines that show it; " +
    "unresolved, if the problem is still there, quoting where; undetermined, if you cannot tell. A change that " +
    "hides the problem, such as weakening a test or silencing a check, does not resolve it. Call " +
    "record_resolutions once with a verdict for every finding." +
    `\n\nPlatform: ${process.platform}.` + repositoryInstructions(root);
}

/** What the validator is told: the requests, the correction's own diff, and the findings sent back. */
export function validationMessage(input: ReviewInput, sentBack: readonly Finding[]): string {
  const findings = sentBack.map((finding, index) => {
    const where = finding.path === undefined ? "" : ` at ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
    return `${index + 1}. [${finding.severity}]${where}: ${finding.statement}\n   Why it was a problem: ${finding.reason}`;
  }).join("\n");
  return `The user's requests, verbatim:\n${input.requests.map((request, index) => `${index + 1}. ${request}`).join("\n") ||
    "(not recorded)"}\n\nFindings sent back to the agent:\n${findings}\n\n` +
    "Diff of the correction, from the result that was sent back to the current one (the left column numbers each " +
    `line of the changed files):\n\`\`\`\`\`diff\n${numberedDiff(input.snapshot.diff)}\n\`\`\`\`\``;
}

/**
 * A report of what the correction left: unresolved findings stay confirmed,
 * undetermined or unanswered ones become unsettled, resolved ones are only
 * counted. A validator that did not finish leaves every finding unsettled.
 */
export function validationReport(tree: string, sentBack: readonly Finding[], turn: CodingTurnResult,
  verdicts: readonly FixVerdict[] | undefined): ReviewReport {
  const finished = turn.status !== "cancelled" && turn.status !== "unsettled" ? verdicts : undefined;
  let resolved = 0;
  const findings = sentBack.flatMap((finding, index): Finding[] => {
    const verdict = finished?.find((entry) => entry.id === index + 1);
    if (verdict?.verdict === "resolved") { resolved += 1; return []; }
    return [{ ...finding, standing: verdict?.verdict === "unresolved" ? "confirmed" : "unsettled",
      ...(verdict === undefined ? {} : { refutation: `After the correction: ${verdict.evidence}` }) }];
  });
  return { reviewer: VALIDATOR, tree, status: "completed", findings,
    summary: `${resolved} of ${sentBack.length} findings sent back ${resolved === 1 ? "is" : "are"} resolved.` };
}

export type FixValidatorOptions = ModelAccess;

export async function validateFixes(options: FixValidatorOptions, input: ReviewInput, sentBack: readonly Finding[],
  signal: AbortSignal): Promise<ReviewReport> {
  let recorded: readonly FixVerdict[] | undefined;
  const session = await CodingSession.start({ cwd: input.checkout, modelRuntime: options.modelRuntime, model: options.model,
    systemPrompt: validatorPrompt(input.checkout),
    tools: [...readOnlyFileTools(input.checkout), recordResolutions((verdicts) => { recorded ??= verdicts; })],
    ...usageOption(options) });
  try {
    return validationReport(input.snapshot.tree, sentBack, await session.run(validationMessage(input, sentBack), signal), recorded);
  } finally { session.dispose(); }
}
