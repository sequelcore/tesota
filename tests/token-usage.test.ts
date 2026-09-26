import { expect, it } from "vitest";
import { NO_TOKENS, addTokens, totalTokens } from "../src/token-usage.js";

// OpenTelemetry's GenAI conventions: input counts every input token, cached or not; cache reads and writes are parts of it.
it("adds usage kind by kind, and totals input and output only, since cached tokens are part of input", () => {
  const first = { input: 3_600, output: 20, cacheRead: 3_000, cacheCreation: 500 };
  const both = addTokens(first, { input: 10, output: 2, cacheRead: 3, cacheCreation: 4 });
  expect(both).toEqual({ input: 3_610, output: 22, cacheRead: 3_003, cacheCreation: 504 });
  expect(totalTokens(both)).toBe(3_632);
  expect(addTokens(NO_TOKENS, first)).toEqual(first);
  expect(totalTokens(NO_TOKENS)).toBe(0);
});
