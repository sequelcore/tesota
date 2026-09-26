import { expect, it } from "vitest";
import { HELPER_ANSWER_LIMIT, helperPrompt, helperResult } from "../src/integrations/pi-helper.js";

it("tells the helper it answers one question, read-only, citing files and what it did not find", () => {
  const prompt = helperPrompt(process.cwd());
  expect(prompt).toContain("You cannot change files or run commands.");
  expect(prompt).toContain("then the files and line numbers you relied on, then what you looked for and did not find");
  expect(prompt).toContain("Repository instructions from AGENTS.md");
});

it("returns the answer, cut at the limit, and never passes an empty or unfinished reply as an answer", () => {
  expect(helperResult({ status: "completed", reply: "  The rule is in src/a.ts:4.  " }, false))
    .toEqual({ status: "answered", answer: "The rule is in src/a.ts:4." });
  const long = helperResult({ status: "completed", reply: "x".repeat(HELPER_ANSWER_LIMIT + 10) }, false);
  expect(long.status === "answered" && long.answer.endsWith(`cut at ${HELPER_ANSWER_LIMIT} characters.]`)).toBe(true);
  expect(helperResult({ status: "completed", reply: " " }, false)).toEqual({ status: "unfinished", reason: "the helper gave no answer" });
  expect(helperResult({ status: "completed", reply: "partial" }, true))
    .toEqual({ status: "unfinished", reason: "the helper ran past its time limit" });
  expect(helperResult({ status: "failed", reason: "401" }, false))
    .toEqual({ status: "unfinished", reason: "the model request failed: 401" });
  expect(helperResult({ status: "cancelled" }, false)).toEqual({ status: "unfinished", reason: "the helper was stopped" });
});
