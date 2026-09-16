import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { assessApplicability, configuredOxlint, runOxlint } from "../src/verification/oxlint.js";
import { DurableVerificationEvidenceStore } from "../src/verification/evidence.js";
import { legacyConfigurationV2 } from "../src/verification/oxlint-input.js";

const renameMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  renameMock.mockImplementation(actual.rename);
  return { ...actual, rename: renameMock };
});

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5000,
}).trim();
const evidenceModule = pathToFileURL(fileURLToPath(new URL("../dist/verification/evidence.js", import.meta.url))).href;
const oxlintModule = pathToFileURL(fileURLToPath(new URL("../dist/verification/oxlint.js", import.meta.url))).href;
const legacyConfigurationV1 = JSON.stringify({
  plugins: [], categories: { correctness: "off" },
  rules: { "no-debugger": "error", "no-unused-vars": "error" },
});
const roots: string[] = [];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source = "export const value = 1;\n") {
  const root = await mkdtemp(join(tmpdir(), "tesota-evidence-test-"));
  roots.push(root);
  const file = join(root, "source.ts");
  await writeFile(file, source, "utf8");
  return { root, file, check: configuredOxlint(root, bun), store: new DurableVerificationEvidenceStore(join(root, "evidence.json")) };
}

it("round-trips a real issued result and re-evaluates it after reload", async () => {
  const { root, file, check, store } = await fixture();
  const result = await runOxlint(check, file);
  expect(result.status).toBe("passed");
  await store.save(result);

  const reloaded = new DurableVerificationEvidenceStore(join(root, "evidence.json"));
  const recovered = await reloaded.load();
  expect(recovered.status).toBe("recovered");
  if (recovered.status !== "recovered") throw new Error("Expected recovered evidence");
  expect(recovered.evidence.historical).toEqual(result);
  expect(recovered.evidence.structuralValidity).toBe("valid");
  expect(recovered.evidence.provenance).toBe("recovered_untrusted");
  expect((await assessApplicability(recovered.evidence, check))).toMatchObject({
    status: "applicable", provenance: "recovered_untrusted",
  });

  await writeFile(file, "debugger;\n", "utf8");
  expect((await assessApplicability(recovered.evidence, check))).toMatchObject({
    status: "stale", provenance: "recovered_untrusted",
  });
  expect(recovered.evidence.historical.status).toBe("passed");

  const child = spawnSync(bun, ["--no-env-file", "-e", `
    (async () => {
      const {DurableVerificationEvidenceStore} = await import(${JSON.stringify(evidenceModule)});
      const {assessApplicability, configuredOxlint} = await import(${JSON.stringify(oxlintModule)});
      const loaded = await new DurableVerificationEvidenceStore(${JSON.stringify(join(root, "evidence.json"))}).load();
      if (loaded.status !== "recovered") throw new Error("Expected recovered evidence");
      const applicability = await assessApplicability(loaded.evidence, configuredOxlint(${JSON.stringify(root)}, ${JSON.stringify(bun)}));
      process.stdout.write(JSON.stringify({status: loaded.status, applicability}));
    })().catch((error) => { process.stderr.write(String(error)); process.exitCode = 1; });
  `], { encoding: "utf8", windowsHide: true, shell: false, timeout: 5000, maxBuffer: 64 * 1024 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  expect(JSON.parse(child.stdout)).toMatchObject({
    status: "recovered", applicability: { status: "stale", provenance: "recovered_untrusted" },
  });
});

it("preserves a check failure while distinguishing missing evidence", async () => {
  const { root, file, check, store } = await fixture("debugger;\n");
  const result = await runOxlint(check, file);
  expect(result.status).toBe("check_failed");
  await store.save(result);
  const recovered = await store.load();
  expect(recovered.status).toBe("recovered");
  if (recovered.status === "recovered") expect(recovered.evidence.historical.status).toBe("check_failed");

  const missing = await new DurableVerificationEvidenceStore(join(root, "missing.json")).load();
  expect(missing).toEqual({ status: "missing" });
});

it.each([
  { profile: "oxlint-basic/v1", configuration: legacyConfigurationV1 },
  { profile: "oxlint-static/v2", configuration: legacyConfigurationV2 },
])("recovers $profile evidence as historical but makes it stale against v3", async ({ profile, configuration }) => {
  const { root, file, check, store } = await fixture();
  const current = await runOxlint(check, file);
  await store.save(current);
  const path = join(root, "evidence.json");
  const durable: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!record(durable)) throw new Error("Expected durable record fixture");
  const result = durable["result"];
  if (!record(result)) throw new Error("Expected durable result fixture");
  const binding = result["binding"];
  if (!record(binding) || !record(binding["check"])) throw new Error("Expected durable binding fixture");
  result["profile"] = profile;
  binding["check"] = { ...binding["check"],
    profile, configuration };
  await writeFile(path, JSON.stringify(durable));

  const recovered = await store.load();
  if (recovered.status !== "recovered") throw new Error("Expected recovered legacy evidence");
  expect(recovered.evidence.historical.profile).toBe(profile);
  expect(await assessApplicability(recovered.evidence, check)).toMatchObject({
    status: "stale", provenance: "recovered_untrusted",
  });
});

it.each(["{", JSON.stringify({ format: "tesota-verification-evidence", version: 99 })])(
  "rejects malformed, truncated, or unsupported durable data %j",
  async (content) => {
    const { root } = await fixture();
    const path = join(root, "evidence.json");
    await writeFile(path, content, "utf8");
    const recovered = await new DurableVerificationEvidenceStore(path).load();
    expect(recovered.status).toBe("invalid");
  },
);

it("does not accept copied or manually serialized content as issued evidence", async () => {
  const { file, check, store } = await fixture();
  const result = await runOxlint(check, file);
  expect(result.status).toBe("passed");
  const copied = structuredClone(result);
  expect(await assessApplicability(copied, check)).toMatchObject({
    status: "unavailable", provenance: "unavailable",
  });
  await expect(store.save(copied)).rejects.toThrow("issued completed");
});

it("leaves no valid passing record when commit is interrupted", async () => {
  const { root, file, check } = await fixture();
  const result = await runOxlint(check, file);
  expect(result.status).toBe("passed");
  const path = join(root, "interrupted.json");
  const interrupted = new DurableVerificationEvidenceStore(path);
  renameMock.mockImplementationOnce(() => { throw new Error("interrupted"); });
  await expect(interrupted.save(result)).rejects.toThrow("interrupted");
  expect(await interrupted.load()).toEqual({ status: "missing" });
  await expect(readFile(path)).rejects.toThrow();
});

it("rejects oversized saves without changing existing recoverable bytes", async () => {
  const { root, file, check, store } = await fixture();
  const previous = await runOxlint(check, file);
  await store.save(previous);
  const path = join(root, "evidence.json");
  const before = await readFile(path);
  await writeFile(file, "debugger;\n".repeat(5500));
  const oversized = await runOxlint({ ...check, timeoutMs: 30_000, maxOutputBytes: 128 * 1024 * 1024 }, file);
  if (oversized.status !== "check_failed") {
    throw new Error(`Expected oversized issued evidence, received ${JSON.stringify(oversized)}`);
  }
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(512 * 1024);
  await expect(store.save(oversized)).rejects.toThrow("512 KiB");
  expect(await readFile(path)).toEqual(before);
  expect(await store.load()).toMatchObject({ status: "recovered", evidence: { historical: previous } });
}, 45_000);

it("compares recovered binding properties independently of object key order", async () => {
  const { root, file, check, store } = await fixture();
  const result = await runOxlint(check, file);
  await store.save(result);
  const path = join(root, "evidence.json");
  const reordered = JSON.stringify(JSON.parse(await readFile(path, "utf8")), (_key, value: unknown) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).reverse());
    }
    return value;
  });
  await writeFile(path, reordered);
  const loaded = await store.load();
  if (loaded.status !== "recovered") throw new Error("Expected recovered evidence");
  expect(await assessApplicability(loaded.evidence, check)).toMatchObject({ status: "applicable" });
  expect(await assessApplicability(loaded.evidence, { ...check, configuration: `${check.configuration}\n` }))
    .toMatchObject({ status: "stale" });
  const historical = loaded.evidence.historical;
  await writeFile(path, JSON.stringify({ format: "tesota-verification-evidence", version: 1,
    result: { ...historical, binding: { ...historical.binding, check: { ...historical.binding.check,
      arguments: [...historical.binding.check.arguments].reverse() } } } }));
  const reorderedArguments = await store.load();
  if (reorderedArguments.status !== "recovered") throw new Error("Expected recovered evidence");
  expect(await assessApplicability(reorderedArguments.evidence, check)).toMatchObject({ status: "stale" });
});

it("rejects malformed UTF-8 within historical diagnostic text", async () => {
  const { root, file, check, store } = await fixture("debugger;\n");
  const result = await runOxlint(check, file);
  expect(result.status).toBe("check_failed");
  await store.save(result);
  const path = join(root, "evidence.json");
  const bytes = await readFile(path);
  const marker = Buffer.from('"message":"');
  const offset = bytes.indexOf(marker);
  expect(offset).toBeGreaterThan(-1);
  bytes[offset + marker.length] = 0xff;
  await writeFile(path, bytes);
  expect(await store.load()).toEqual({ status: "invalid", reason: "malformed_or_truncated" });
  const child = spawnSync(bun, ["--no-env-file", "-e", `
    const {DurableVerificationEvidenceStore} = await import(${JSON.stringify(evidenceModule)});
    process.stdout.write(JSON.stringify(await new DurableVerificationEvidenceStore(${JSON.stringify(path)}).load()));
  `], { encoding: "utf8", windowsHide: true, shell: false, timeout: 5000, maxBuffer: 64 * 1024 });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  expect(child.stderr).toBe("");
  expect(JSON.parse(child.stdout)).toEqual({ status: "invalid", reason: "malformed_or_truncated" });
});

it("preserves existing recoverable bytes when replacement rename fails", async () => {
  const { root, file, check, store } = await fixture("debugger;\n");
  const previous = await runOxlint(check, file);
  await store.save(previous);
  const path = join(root, "evidence.json");
  const before = await readFile(path);
  await writeFile(file, "export const value = 1;\n");
  const replacement = await runOxlint(check, file);
  expect(replacement.status).toBe("passed");
  renameMock.mockRejectedValueOnce(new Error("replacement interrupted"));
  await expect(store.save(replacement)).rejects.toThrow("replacement interrupted");
  expect(await readFile(path)).toEqual(before);
  expect(await store.load()).toMatchObject({ status: "recovered", evidence: { historical: previous } });
});

it("recognizes only parser-created recovered evidence and never promotes it to issued", async () => {
  const { file, check, store } = await fixture();
  const result = await runOxlint(check, file);
  await store.save(result);
  const loaded = await store.load();
  if (loaded.status !== "recovered") throw new Error("Expected recovered evidence");
  expect(await assessApplicability(structuredClone(loaded.evidence), check))
    .toMatchObject({ status: "unavailable", provenance: "unavailable" });
  await expect(store.save(loaded.evidence.historical)).rejects.toThrow("issued completed");
  const exports = await import("../src/verification/oxlint-result.js");
  expect(exports).not.toHaveProperty("registerRecoveredEvidence");
});
