import { expect, it } from "vitest";
import { EXPLORER_ANSWER_LIMIT, explorerPrompt, explorerResult } from "../src/integrations/pi-explorer.js";

it("tells the explorer it answers one question, read-only, citing files and what it did not find", () => {
  const prompt = explorerPrompt(process.cwd());
  expect(prompt).toContain("You cannot change files or run commands.");
  expect(prompt).toContain("then the files and line numbers you relied on, then what you looked for and did not find");
  expect(prompt).toContain("Repository instructions from AGENTS.md");
});

it("returns the answer, cut at the limit, and never passes an empty or unfinished reply as an answer", () => {
  expect(explorerResult({ status: "completed", reply: "  The rule is in src/a.ts:4.  " }, false))
    .toEqual({ status: "answered", answer: "The rule is in src/a.ts:4." });
  const long = explorerResult({ status: "completed", reply: "x".repeat(EXPLORER_ANSWER_LIMIT + 10) }, false);
  expect(long.status === "answered" && long.answer.endsWith(`cut at ${EXPLORER_ANSWER_LIMIT} characters.]`)).toBe(true);
  expect(explorerResult({ status: "completed", reply: " " }, false)).toEqual({ status: "unfinished", reason: "the explorer gave no answer" });
  expect(explorerResult({ status: "completed", reply: "partial" }, true))
    .toEqual({ status: "unfinished", reason: "the explorer ran past its time limit" });
  expect(explorerResult({ status: "failed", reason: "401" }, false))
    .toEqual({ status: "unfinished", reason: "the model request failed: 401" });
  expect(explorerResult({ status: "cancelled" }, false)).toEqual({ status: "unfinished", reason: "the explorer was stopped" });
});
