import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { assessApplicability, configuredOxlint, runOxlint } from "../src/verification/oxlint.js";
import { DurableVerificationEvidenceStore } from "../src/verification/evidence.js";

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
const roots: string[] = [];

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
