import { expect, test } from "bun:test";
import { providerError } from "../src/provider-error.ts";

test("provider diagnostics redact authorization schemes and credential-shaped fields", () => {
  const result = providerError('503: Authorization: Basic synthetic-basic; api key: synthetic-key; {"access_token":"synthetic-token"}; https://user:synthetic-password@example.test/path?api_key=synthetic-query');
  expect(result).toContain("503:");
  for (const value of ["synthetic-basic", "synthetic-key", "synthetic-token", "synthetic-password", "synthetic-query"]) expect(result).not.toContain(value);
});

test("provider diagnostics remove terminal controls and redact before truncating", () => {
  const result = providerError(`\x1b[2J503: api_key=${"s".repeat(3000)} ${"x".repeat(3000)}`);
  expect(result).toStartWith("503: api_key=[redacted]");
  expect(result).not.toContain("\x1b");
  expect(result).toHaveLength(2000);
});
