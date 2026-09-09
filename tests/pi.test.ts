import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runPiSession } from "../src/integrations/pi.js";
import { DurableVerificationEvidenceStore } from "../src/verification/evidence.js";
import { configuredOxlint, runOxlint } from "../src/verification/oxlint.js";

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5_000,
}).trim();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source = "export const value = 1;\n") {
  const root = await mkdtemp(join(tmpdir(), "tesota-pi-test-"));
  roots.push(root);
  const file = join(root, "source.ts");
  await writeFile(file, source, "utf8");
  return { root, file, check: configuredOxlint(root, bun) };
}

it("runs one synthetic successful Pi turn without task acceptance", async () => {
  const { file, check } = await fixture();
  const result = await runPiSession({ check, input: file, scenario: "successful_turn" });

  expect(result.status).toBe("completed");
  expect(result.taskAcceptance).toBe("not_evaluated");
  expect(result.response).toContain("Synthetic Pi turn completed.");
  expect(result.events.map((event) => event.type)).toEqual([
    "session_started", "turn_started", "turn_completed", "session_completed",
  ]);
});

it("admits one synthetic verification request and continues with a bounded result", async () => {
  const { file, check } = await fixture();
  const result = await runPiSession({ check, input: file, scenario: "verification_request" });

  expect(result.status).toBe("completed");
  expect(result.response).toContain("continued after the bounded Tesota result");
  expect(result.verification).toMatchObject({ status: "passed", process: "exited" });
  expect(result.issuedEvidence).toBe(result.verification);
  expect(result.events).toEqual(expect.arrayContaining([
    { type: "verification_requested", input: file },
    { type: "verification_admitted", input: file },
    { type: "verification_completed", status: "passed" },
  ]));
});

it("denies an unadmitted verification action at the Tesota boundary", async () => {
  const { file, check } = await fixture();
  const result = await runPiSession({
    check, input: file, scenario: "verification_request", admitVerification: false,
  });

  expect(result.status).toBe("completed");
  expect(result.verification).toBeUndefined();
  expect(result.issuedEvidence).toBeUndefined();
  expect(result.events).toEqual(expect.arrayContaining([
    { type: "verification_denied", input: file, reason: "not_admitted_by_tesota" },
    { type: "session_completed", taskAcceptance: "not_evaluated" },
  ]));
});

it("propagates a shared-executor check failure through the Pi turn", async () => {
  const { file, check } = await fixture("debugger;\n");
  const result = await runPiSession({ check, input: file, scenario: "verification_request" });

  expect(result.verification).toMatchObject({ status: "check_failed", process: "exited" });
  expect(result.issuedEvidence?.status).toBe("check_failed");
  expect(result.response).toContain("continued after the bounded Tesota result");
});

it("propagates a shared-executor execution failure without treating it as success", async () => {
  const { root, file, check } = await fixture();
  const result = await runPiSession({
    check: { ...check, executable: join(root, "missing-bun.exe") },
    input: file,
    scenario: "verification_request",
  });

  expect(result.status).toBe("completed");
  expect(result.verification).toMatchObject({
    status: "execution_failed", reason: "spawn_failed", process: "not_started",
  });
  expect(result.issuedEvidence).toBeUndefined();
  expect(result.taskAcceptance).toBe("not_evaluated");
});

it("observes Pi abort as aborted rather than successful completion", async () => {
  const { file, check } = await fixture();
  const result = await runPiSession({ check, input: file, scenario: "abort" });

  expect(result.status).toBe("aborted");
  expect(result.events).toContainEqual({ type: "session_aborted", reason: "aborted" });
  expect(result.events).not.toContainEqual({ type: "session_completed", taskAcceptance: "not_evaluated" });
});

it("does not promote recovered_untrusted evidence when it crosses the Pi action boundary", async () => {
  const { file, check } = await fixture();
  const issued = await runOxlint(check, file);
  if (issued.status !== "passed") throw new Error("Expected a passing issued result");
  const store = new DurableVerificationEvidenceStore(join(check.cwd, "evidence.json"));
  await store.save(issued);
  const loaded = await store.load();
  if (loaded.status !== "recovered") throw new Error("Expected recovered evidence");

  const result = await runPiSession({
    check,
    input: file,
    scenario: "verification_request",
    verificationExecutor: async () => loaded.evidence.historical,
  });

  expect(result.verification).toMatchObject({
    status: "execution_failed", reason: "unissued_verification_result",
  });
  expect(result.issuedEvidence).toBeUndefined();
  expect(result.events).toContainEqual({ type: "verification_completed", status: "execution_failed" });
});
