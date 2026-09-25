import { expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hostProvider } from "../src/host-environment.js";
import { reviewMessage, reviewReport, submitReviewTool } from "../src/integrations/pi-reviewer.js";
import type { Finding, ReviewInput } from "../src/review.js";

const tree = "t".repeat(40);
const input: ReviewInput = {
  checkout: "C:/work/repo",
  requests: ["Give orders over $100 a 10% discount", "Keep rounding to cents"],
  snapshot: { base: "b".repeat(40), tree, changes: [{ status: "modified", path: "src/price.ts" },
    { status: "modified", path: "src/price.test.ts" }], diff: "diff --git a/src/price.ts b/src/price.ts\n-a\n+b" },
  checks: [{ verifier: "command" as const, claim: "exits 0", limits: "only what it tests", command: "bun run check", tree, environment: "host", guarantees: hostProvider.guarantees,
    outcome: "failed", exitCode: 1, durationMs: 5, output: "FAIL price.test.ts\nexpected 90, got 100\n" }],
  flags: [{ path: "src/price.test.ts", status: "modified", kind: "test" }],
};

it("tells the reviewer the requests verbatim, the flags, the check evidence and the diff", () => {
  const message = reviewMessage(input);
  expect(message).toContain("1. Give orders over $100 a 10% discount\n2. Keep rounding to cents");
  expect(message).toContain("- modified src/price.test.ts (test)");
  expect(message).toContain("- bun run check: failed, exit 1\n  A pass establishes: exits 0\n" +
    "  It does not establish: only what it tests\n  last output:\n    FAIL price.test.ts\n    expected 90, got 100");
  expect(message).toContain("`````diff\ndiff --git a/src/price.ts b/src/price.ts\n-a\n+b\n`````");
});

it("cuts a long diff and says so", () => {
  const message = reviewMessage({ ...input, snapshot: { ...input.snapshot, diff: "x".repeat(200_000) } });
  expect(message).toContain("[The diff is cut at 150000 characters; read the files for the rest.]");
  expect(message.length).toBeLessThan(160_000);
});

const finding: Finding = { severity: "high", disposition: "fixable", path: "src/price.ts", line: 3,
  statement: "Orders of exactly $100 get the discount", reason: "The request says over $100; the code uses >=" };

it("counts a review only when it was submitted and not stopped", () => {
  const submitted = { summary: "Mostly right", findings: [finding] };
  expect(reviewReport(tree, { status: "completed", reply: "" }, submitted))
    .toEqual({ reviewer: "Tesota reviewer", tree, status: "completed", summary: "Mostly right", findings: [finding] });
  expect(reviewReport(tree, { status: "completed", reply: "Looks good" }, undefined)).toMatchObject({
    status: "incomplete", reason: "the reviewer finished without submitting its findings" });
  expect(reviewReport(tree, { status: "cancelled" }, submitted)).toMatchObject({ status: "incomplete", reason: "the review was stopped" });
  expect(reviewReport(tree, { status: "unsettled" }, submitted)).toMatchObject({ status: "incomplete" });
  expect(reviewReport(tree, { status: "failed", reason: "rate limited" }, undefined))
    .toMatchObject({ status: "incomplete", reason: "the model request failed: rate limited" });
});

it("records only the first submission and ends the review", async () => {
  const recorded: { summary: string; findings: readonly Finding[] }[] = [];
  const tool = submitReviewTool((summary, findings) => {
    if (recorded.length > 0) return false;
    recorded.push({ summary, findings });
    return true;
  });
  const context = {} as ExtensionContext;
  const submission = { summary: "One problem", findings: [{ severity: "high" as const, disposition: "fixable" as const,
    statement: finding.statement, reason: finding.reason }] };
  const first = await tool.execute("call-1", submission, undefined, undefined, context);
  const second = await tool.execute("call-2", { summary: "Changed my mind", findings: [] }, undefined, undefined, context);
  expect(first).toMatchObject({ terminate: true, content: [{ type: "text", text: "Review recorded." }] });
  expect(second.content).toEqual([{ type: "text", text: "A review was already recorded; only the first submission counts." }]);
  expect(recorded).toEqual([{ summary: "One problem", findings: [{ severity: "high", disposition: "fixable",
    statement: finding.statement, reason: finding.reason }] }]);
});

it("reminds a reviewer that answered in prose once, and then accepts its submission", async () => {
  const { vi } = await import("vitest");
  const { CodingSession } = await import("../src/integrations/pi-coding-session.js");
  const { createPiReviewer } = await import("../src/integrations/pi-reviewer.js");
  const prompts: string[] = [];
  const start = vi.spyOn(CodingSession, "start").mockImplementation(async (options) => {
    const submit = options.tools.find((tool) => tool.name === "submit_review");
    return { dispose: vi.fn(), run: vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 2) {
        await submit?.execute("call", { summary: "Late but complete", findings: [] }, undefined, undefined, {} as ExtensionContext);
      }
      return { status: "completed" as const, reply: "It looks fine." };
    }) } as unknown as Awaited<ReturnType<typeof CodingSession.start>>;
  });
  try {
    const reviewer = createPiReviewer({ modelRuntime: {} as never, model: {} as never });
    const report = await reviewer.review({ ...input, checkout: process.cwd() }, new AbortController().signal);
    expect(report).toEqual({ reviewer: "Tesota reviewer", tree, status: "completed", summary: "Late but complete", findings: [] });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("You finished without calling submit_review");
  } finally { start.mockRestore(); }
});
