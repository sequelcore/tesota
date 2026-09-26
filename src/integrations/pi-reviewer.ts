import { realpathSync } from "node:fs";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "@earendil-works/pi-ai";
import { numberedDiff } from "../diff-lines.js";
import type { Finding, ReviewInput, ReviewReport, Reviewer } from "../review.js";
import { type ModelAccess, startModelSession } from "./model-session.js";
import { type AgentActivity, type CodingTurnResult, readOnlyFileTools, repositoryInstructions } from "./pi-coding-session.js";

const REVIEWER = "Tesota reviewer";
const diffLimit = 150_000;
const checkOutputLimit = 2_000;

const findingSchema = Type.Object({
  severity: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")],
    { description: "high: the request is not met or something breaks; medium: likely wrong or not covered; low: minor" }),
  disposition: Type.Union([Type.Literal("fixable"), Type.Literal("operator")],
    { description: "fixable: a clear defect against the requests that can be fixed without asking the user; " +
      "operator: needs the user's judgment" }),
  origin: Type.Union([Type.Literal("introduced"), Type.Literal("preexisting"), Type.Literal("unknown")],
    { description: "introduced: this change caused it; preexisting: it was already there before the change; " +
      "unknown: you cannot tell which" }),
  path: Type.Optional(Type.String({ description: "Repository-relative file, when the finding has a location" })),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "The line in the changed file, as numbered in the diff's " +
    "left column; for a problem the change causes, the changed line that causes it" })),
  statement: Type.String({ description: "The problem, in one sentence" }),
  reason: Type.String({ description: "What in the requests, the code or the checks shows it" }),
});
const submissionSchema = Type.Object({
  summary: Type.String({ description: "One paragraph: whether the result does what was asked, and how well the checks cover it" }),
  findings: Type.Array(findingSchema, { description: "Every real problem; an empty list when there are none" }),
});
type Submission = Static<typeof submissionSchema>;

function finding(submitted: Submission["findings"][number]): Finding {
  return { severity: submitted.severity, disposition: submitted.disposition, origin: submitted.origin, statement: submitted.statement,
    reason: submitted.reason,
    ...(submitted.path === undefined ? {} : { path: submitted.path }),
    ...(submitted.line === undefined ? {} : { line: submitted.line }) };
}

/** The reviewer's only way to report: one structured submission, after which the review ends. */
export function submitReviewTool(record: (summary: string, findings: readonly Finding[]) => boolean): ToolDefinition {
  return defineTool({
    name: "submit_review", label: "Submit review",
    description: "Submit your review once you have finished investigating. Call it exactly once.",
    parameters: submissionSchema,
    execute: async (_id, submission) => {
      const accepted = record(submission.summary, submission.findings.map(finding));
      return { content: [{ type: "text", text: accepted ? "Review recorded." :
        "A review was already recorded; only the first submission counts." }], details: undefined, terminate: true };
    },
  });
}

/**
 * A focused review for deep reviews (decision 016), in the manner of Codex's
 * per-skill reviewers and Gentle AI's lenses (MIT). Each lens reports only
 * within its focus; the request-conformance reviewer covers the rest.
 */
export interface ReviewLens {
  readonly name: string;
  readonly focus: string;
  /** Whether the lens needs the repository's own instruction file. */
  readonly needsInstructions?: boolean;
}

export const REVIEW_LENSES: readonly ReviewLens[] = [
  { name: "correctness and regressions", focus: "Focus only on logic errors, boundary and edge cases, error handling, " +
    "and callers or data the change breaks. For each problem, name the inputs that trigger it and the affected code." },
  { name: "security and authority", focus: "Focus only on authorization and access decisions, input validation, " +
    "secrets and credentials, injection, and unsafe defaults. Report a concrete way the change allows something the " +
    "requests or the existing code do not allow, not general hardening advice." },
  { name: "repository rules", needsInstructions: true, focus: "Focus only on the repository's own instructions, " +
    "quoted at the end. Report a violation only when a specific rule applies to the changed code, and quote the rule " +
    "with its file and line in the reason." },
];

function reviewerPrompt(root: string, lens?: ReviewLens): string {
  const focus = lens === undefined ? "" : `\n\nThis is a focused review: ${lens.focus} Other reviewers cover the rest: ` +
    "do not report a problem outside your focus, and submit an empty list when you find none within it.";
  return "You are Tesota's reviewer. Another agent changed a private copy of a repository to satisfy the user's " +
    "requests; Tesota froze the result and ran the repository's checks on it. Judge whether the result does what " +
    "the user asked and whether the checks' evidence covers it. You cannot change files: investigate with the " +
    "read, search and list tools, reading the changed files and whatever they touch. Passing checks show only " +
    "that the code meets its tests; ask whether those tests reflect the requests. Judge what this change " +
    "introduced: mark a problem that was already there before the change as preexisting, and one whose cause you " +
    "cannot tell as unknown; Tesota checks each origin against the diff. For an introduced " +
    "problem outside the diff, name the code that is provably affected rather than speculating. Do not rely on " +
    "assumptions about intent that the requests do not state. For every change Tesota lists " +
    "as altering what checks the result, say whether it weakens what is checked. Report only real problems, not " +
    "style preferences. Use disposition `operator` for an ambiguous requirement, a trade-off without one right " +
    "answer, a changed test or check whose legitimacy depends on intent, work beyond what was asked, or a " +
    "security-sensitive choice; use `fixable` for a clear defect against the requests. When you are done, call " +
    "submit_review exactly once, with an empty list if you found no problems." + focus +
    `\n\nPlatform: ${process.platform}.` + repositoryInstructions(root);
}

function checkLine(check: ReviewInput["checks"][number]): string {
  const exit = check.exitCode === null ? "" : `, exit ${check.exitCode}`;
  const output = check.outcome === "passed" || check.output.trim().length === 0 ? "" :
    `\n  last output:\n${check.output.trimEnd().slice(-checkOutputLimit).replace(/^/gmu, "    ")}`;
  return `- ${check.command}: ${check.outcome.replace("_", " ")}${exit}\n  A pass establishes: ${check.claim}\n` +
    `  It does not establish: ${check.limits}${output}`;
}

/** What the reviewer is told: the requests verbatim, the evidence, the flags and the diff; never the worker's reasoning. */
export function reviewMessage(input: ReviewInput): string {
  const { snapshot } = input;
  const numbered = numberedDiff(snapshot.diff);
  const diff = numbered.length <= diffLimit ? numbered :
    `${numbered.slice(0, diffLimit)}\n[The diff is cut at ${diffLimit} characters; read the files for the rest.]`;
  return [
    `The user's requests, verbatim:\n${input.requests.map((request, index) => `${index + 1}. ${request}`).join("\n") ||
      "(not recorded)"}`,
    `Changed files:\n${snapshot.changes.map((change) => `- ${change.status} ${change.path}`).join("\n")}`,
    `Changes that alter what checks the result (Tesota's fixed rules):\n${input.flags.map((flag) =>
      `- ${flag.status} ${flag.path} (${flag.kind})`).join("\n") || "- none"}`,
    `Checks Tesota ran on this exact content:\n${input.checks.map(checkLine).join("\n") || "- none ran"}`,
    ...(input.correction === undefined ? [] : [`This is a correction round. These problems were sent back to the agent ` +
      `and a separate validator checks them; report only problems the correction itself introduced:\n` +
      input.correction.sentBack.map((finding) => `- ${finding.statement}`).join("\n")]),
    `${input.correction === undefined ? "Diff from the starting point" :
      "Diff of the correction, from the result that was sent back to the current one"} ` +
      `(the left column numbers each line of the changed files):\n\`\`\`\`\`diff\n${diff}\n\`\`\`\`\``,
  ].join("\n\n");
}

/** A review counts only when the reviewer submitted it and was not stopped. */
export function reviewReport(tree: string, turn: CodingTurnResult,
  submitted: { readonly summary: string; readonly findings: readonly Finding[] } | undefined): ReviewReport {
  const incomplete = (reason: string): ReviewReport => ({ reviewer: REVIEWER, tree, status: "incomplete", reason });
  if (turn.status === "cancelled") return incomplete("the review was stopped");
  if (turn.status === "unsettled") return incomplete("the reviewer did not stop cleanly");
  if (submitted !== undefined) return { reviewer: REVIEWER, tree, status: "completed", ...submitted };
  if (turn.status === "failed") return incomplete(`the model request failed: ${turn.reason}`);
  return incomplete("the reviewer finished without submitting its findings");
}

const submissionReminder = "You finished without calling submit_review, so Tesota has no review. Call submit_review " +
  "now with the findings you reached, or an empty list if there are none. Do not investigate further.";

export interface PiReviewerOptions extends ModelAccess {
  readonly onActivity?: (activity: AgentActivity) => void;
  /** A focused lens; without one, the reviewer judges conformance to the requests as a whole. */
  readonly lens?: ReviewLens;
}

/** The lenses that apply to a repository: the rules lens only where it has instructions to apply. */
export function applicableLenses(root: string): ReviewLens[] {
  const instructions = repositoryInstructions(root) !== "";
  return REVIEW_LENSES.filter((lens) => lens.needsInstructions !== true || instructions);
}

/**
 * Tesota's first reviewer: a fresh Pi session on the candidate's checkout with
 * read-only file tools, no shell, and none of the working agent's context.
 */
export function createPiReviewer(options: PiReviewerOptions): Reviewer {
  const name = options.lens === undefined ? REVIEWER : `${REVIEWER} · ${options.lens.name}`;
  return {
    name,
    async review(input, signal) {
      const root = realpathSync(input.checkout);
      let submitted: { summary: string; findings: readonly Finding[] } | undefined;
      const session = await startModelSession(options, { cwd: root,
        systemPrompt: reviewerPrompt(root, options.lens),
        tools: [...readOnlyFileTools(root), submitReviewTool((summary, findings) => {
          if (submitted !== undefined) return false;
          submitted = { summary, findings };
          return true;
        })],
        ...(options.onActivity === undefined ? {} : { onActivity: options.onActivity }) });
      try {
        let turn = await session.run(reviewMessage(input), signal);
        // A model sometimes answers in prose; one reminder, without new investigation, before the review counts as unfinished.
        if (turn.status === "completed" && submitted === undefined) turn = await session.run(submissionReminder, signal);
        return { ...reviewReport(input.snapshot.tree, turn, submitted), reviewer: name };
      } finally { session.dispose(); }
    },
  };
}
