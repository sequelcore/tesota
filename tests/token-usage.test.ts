import { expect, it } from "vitest";
import { NO_TOKENS, addTokens, totalTokens } from "../src/token-usage.js";

it("adds usage kind by kind and totals every kind", () => {
  const first = { input: 100, output: 20, cacheRead: 3_000, cacheWrite: 500 };
  const both = addTokens(first, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  expect(both).toEqual({ input: 101, output: 22, cacheRead: 3_003, cacheWrite: 504 });
  expect(totalTokens(both)).toBe(3_630);
  expect(addTokens(NO_TOKENS, first)).toEqual(first);
  expect(totalTokens(NO_TOKENS)).toBe(0);
});
