import { expect, it } from "vitest";
import { boundedReferences, readReferences, referenceDigest, referenceLimits, type RequestReference } from "../src/request-references.js";
import { referenceFits } from "../src/verification/request-context-rule.js";

const reference = (text: string, source = "https://github.com/fixture/project/issues/637"): RequestReference =>
  ({ status: "read", source, text, callId: "read", digest: referenceDigest(text) });

it("keeps whole issue snapshots or explicit gaps, and bounding twice changes nothing (#637)", () => {
  const references = [reference("é".repeat(referenceLimits.bytes / 2)), reference("extra", "https://github.com/fixture/project/issues/638")];
  const bounded = boundedReferences(references);
  expect(bounded[0]).toEqual(references[0]);
  expect(bounded[1]).toMatchObject({ status: "unavailable", reason: expect.stringContaining("byte limit") });
  expect(boundedReferences(bounded)).toEqual(bounded);
  const many = boundedReferences(Array.from({ length: 12 }, (_, index) => reference("body", `https://github.com/f/p/issues/${index + 1}`)));
  expect(many.length).toBeLessThanOrEqual(referenceLimits.count);
  expect(many.at(-1)).toMatchObject({ status: "unavailable", reason: expect.stringContaining("5 references") });
  expect(boundedReferences(many)).toEqual(many);
  expect(readReferences(JSON.parse(JSON.stringify(bounded)))).toEqual(bounded);
});

it("refuses changed or malformed inherited text instead of converting it to operator input (#637)", () => {
  const good = reference("original");
  expect(readReferences([{ ...good, text: "changed" }])).toBeUndefined();
  expect(readReferences([{ status: "read", source: "issue", text: "body" }])).toBeUndefined();
  expect(readReferences({})).toBeUndefined();
  expect(readReferences([reference("x".repeat(referenceLimits.bytes + 1))])).toBeUndefined();
});

it("checks both reference-budget boundaries, including exact byte capacity (#637)", () => {
  expect(referenceFits(7, 100, 28, 8, 128)).toBe(true);
  expect(referenceFits(7, 100, 29, 8, 128)).toBe(false);
  expect(referenceFits(8, 0, 0, 8, 128)).toBe(false);
});
