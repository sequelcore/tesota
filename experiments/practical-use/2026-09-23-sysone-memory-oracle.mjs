import assert from "node:assert/strict";
import { totalmem } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = process.argv[2];
if (!source) throw new Error("Pass the path to src/defaults.ts");
const { platformRecommendation, QUALITY_MEMORY_THRESHOLD } = await import(
  pathToFileURL(resolve(source)).href
);

const base = { platform: "linux", arch: "x64" };
const invalid = [-1, 1.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1];
for (const memoryBytes of invalid) {
  assert.throws(() => platformRecommendation({ ...base, memoryBytes }), RangeError);
  assert.throws(() => platformRecommendation({ ...base, memoryBytes, tier: "quality" }), RangeError);
  assert.throws(
    () => platformRecommendation({ platform: "unknown", arch: "x64", memoryBytes }),
    RangeError,
  );
}

assert.equal(platformRecommendation({ ...base, memoryBytes: 0 }).tier, "compact");
assert.equal(platformRecommendation({ ...base, memoryBytes: QUALITY_MEMORY_THRESHOLD - 1 }).tier, "compact");
assert.equal(platformRecommendation({ ...base, memoryBytes: QUALITY_MEMORY_THRESHOLD }).tier, "quality");
assert.equal(platformRecommendation({ ...base, memoryBytes: 0, tier: "quality" }).tier, "quality");
assert.equal(platformRecommendation({ platform: "unknown", arch: "x64", memoryBytes: 0 }).supported, false);
assert.equal(
  platformRecommendation(base).tier,
  totalmem() >= QUALITY_MEMORY_THRESHOLD ? "quality" : "compact",
);
process.stdout.write("sysone-memory oracle passed\n");
