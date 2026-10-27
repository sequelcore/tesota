import { expect, test } from "bun:test";
import { retryProviderCall } from "../src/provider-retry-rule.ts";

test("retry decision boundaries match #698", () => {
  expect(retryProviderCall(false, false, 429, 0, 0, 1000)).toBe(true);
  expect(retryProviderCall(false, false, 599, 2, 118_999, 1000)).toBe(true);
  expect(retryProviderCall(false, true, 0, 3, 0, 1000)).toBe(false);
  expect(retryProviderCall(false, true, 0, 2, 119_000, 1000)).toBe(false);
  expect(retryProviderCall(false, true, 0, 0, 0, 120_001)).toBe(false);
  expect(retryProviderCall(true, true, 503, 0, 0, 1000)).toBe(false);
  expect(retryProviderCall(false, true, 401, 0, 0, 1000)).toBe(false);
  expect(retryProviderCall(false, true, 403, 0, 0, 1000)).toBe(false);
  expect(retryProviderCall(false, true, 400, 0, 0, 1000)).toBe(false);
  expect(retryProviderCall(false, false, 0, 0, 0, 1000)).toBe(false);
  expect(retryProviderCall(false, false, 600, 0, 0, 1000)).toBe(false);
});
