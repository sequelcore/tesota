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

for (const [url, secrets] of [
  ["https://example.test/models?key=AIzaSySyntheticKey&alt=sse", ["AIzaSySyntheticKey", "alt=sse"]],
  ["https://example.test/models?sig=SECRET&code=XYZ", ["SECRET", "XYZ"]],
  ["https://example.test/models?signature=SIGNED&token=TOKEN&access_token=ACCESS", ["SIGNED", "TOKEN", "ACCESS"]],
] as const) test(`provider diagnostics strip URL query secrets: ${url}`, () => {
  const result = providerError(`Request failed: ${url}`);
  expect(result).toContain("https://example.test/models");
  for (const secret of secrets) expect(result).not.toContain(secret);
});

for (const prefix of ["AIza", "ghp_", "gho_", "gsk_", "xai-", "sk-or-"]) test(`provider diagnostics redact ${prefix} tokens`, () => {
  expect(providerError(`Incorrect API key provided: ${prefix}abc123def`)).toBe("Incorrect API key provided: [redacted]");
});

for (const url of [
  String.raw`https://example.test/models?alt=sse\u0026sig=SECRET\u0026code=XYZ`,
  String.raw`https:\/\/example.test\/models?signature=SECRET&code=XYZ`,
]) test(`provider diagnostics strip JSON-escaped URL query secrets: ${url}`, () => {
  const result = providerError(`Request failed: "${url}"; provider rejected the request`);
  expect(result).not.toContain("SECRET");
  expect(result).not.toContain("XYZ");
  expect(result).toContain("provider rejected the request");
});

for (const [input, expected] of [
  ["www.h.example/p?sig=FAKE_SIGNATURE", "www.h.example/p?sig=[redacted]"],
  ["path /v1/models?key=FAKE_KEY 400", "path /v1/models?key=[redacted] 400"],
] as const) test(`provider diagnostics redact scheme-less query secrets: ${input}`, () => {
  expect(providerError(input)).toBe(expected);
});

for (const name of ["key", "sig", "signature", "code", "token", "access_token"]) test(`provider diagnostics redact scheme-independent &${name} values`, () => {
  const result = providerError(`path /v1/models?model=fixture&${name}=FAKE_VALUE 400`);
  expect(result).not.toContain("FAKE_VALUE");
  expect(result).toContain(`&${name}=[redacted]`);
  expect(result).toEndWith(" 400");
});
