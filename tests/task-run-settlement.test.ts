import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateTask, CandidateTaskCheck } from "../src/candidate-task.js";
import type { PiTaskResult } from "../src/integrations/pi-task.js";

const state = vi.hoisted(() => ({
  failure: null as null | "write" | "sync" | "close",
  writes: [] as string[],
  writeCalls: 0,
  syncCalls: 0,
  usage: { reads: 0, edits: 0, checks: 0 },
  budget: null as null | "model" | "tool" | "time",
  r1Failure: null as null | "write" | "sync" | "close",
  beginExecutions: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original,
    readFile: vi.fn(async () => Buffer.from("executor")),
    writeFile: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    open: vi.fn(async (path: string) => {
      let localWrites = 0; let localSyncs = 0;
      const r1 = path.includes("attempt-r1.partial");
      return {
      writeFile: async (value: string) => {
        localWrites += 1;
        state.writeCalls += 1;
        if (r1 && state.r1Failure === "write" && localWrites === 2) throw new Error("synthetic R1 write failure");
        if (state.failure === "write" && state.writeCalls === 2) throw new Error("synthetic final write failure");
        state.writes.push(value);
      },
      sync: async () => {
        localSyncs += 1;
        state.syncCalls += 1;
        if (r1 && state.r1Failure === "sync" && localSyncs === 2) throw new Error("synthetic R1 sync failure");
        if (state.failure === "sync" && state.syncCalls === 2) throw new Error("synthetic final sync failure");
      },
      close: async () => {
        if (r1 && state.r1Failure === "close") throw new Error("synthetic R1 close failure");
        if (state.failure === "close") throw new Error("synthetic close failure");
      },
    }; }),
  };
});

vi.mock("../src/candidate-checkout.js", () => ({
  createCandidateCheckout: vi.fn(async () => ({ directory: "candidate", checkout: "candidate/repo",
    baseline: "a".repeat(40), sourceDirty: false })),
  candidateDiff: vi.fn(async () => "diff"),
}));

const currentCheck = vi.hoisted(() => ({ value: null as CandidateTaskCheck | null }));
const parentAdmission = vi.hoisted(() => ({
  calls: 0,
  pauseOnCall: 0,
  entered: null as (() => void) | null,
  release: null as Promise<void> | null,
  candidateIdentity: "candidate-r0",
  attemptIdentity: "attempt-r0",
  checkIdentity: "check-r0",
  admittedIdentity: "",
}));
vi.mock("../src/candidate-task.js", () => ({
  CandidateTask: { prepare: vi.fn(async () => ({
    beginExecution: vi.fn(() => { state.beginExecutions += 1; return { close: vi.fn() }; }),
    usage: vi.fn(() => state.usage),
    describe: vi.fn(() => ({ definitionSha256: "e".repeat(64) })),
    close: vi.fn(),
  }) as unknown as CandidateTask) },
  checkCandidateTask: vi.fn(async () => currentCheck.value),
}));

vi.mock("../src/task-review.js", () => ({
  validateCorrectionParent: vi.fn(async () => {
    parentAdmission.calls += 1;
    if (parentAdmission.calls === parentAdmission.pauseOnCall) {
      parentAdmission.entered?.();
      if (parentAdmission.release !== null) await parentAdmission.release;
    }
    const identity = JSON.stringify([parentAdmission.candidateIdentity, parentAdmission.attemptIdentity,
      parentAdmission.checkIdentity]);
    if (parentAdmission.calls === 1) parentAdmission.admittedIdentity = identity;
    else if (identity !== parentAdmission.admittedIdentity) throw new Error("Semantic correction parent evidence invalid");
    if (currentCheck.value === null) throw new Error("Semantic correction parent evidence invalid");
    return { check: currentCheck.value, attemptSha256: "9".repeat(64) };
  }),
}));

const session = vi.hoisted(() => ({ value: null as PiTaskResult | null }));
vi.mock("../src/integrations/pi-task.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/integrations/pi-task.js")>();
  return { ...original,
    runPiTask: vi.fn(async (_task, _model, _stream, _signal, budget) => {
      if (state.budget === "model") budget.modelInvocations = original.PI_TASK_LIMITS.modelInvocations;
      if (state.budget === "tool") budget.toolCalls = original.PI_TASK_LIMITS.toolCalls;
      if (state.budget === "time") budget.activeMs = original.PI_TASK_LIMITS.sessionMs;
      return session.value;
    }),
    piTaskPasses: vi.fn(() => true),
    piSemanticRevisionPasses: vi.fn(() => true),
  };
});

vi.mock("../src/integrations/pi-live.js", () => ({
  LIVE_CODEX_MODEL_ID: "gpt-5.6-luna",
  storedCodexModels: vi.fn(async () => ({
    getModel: () => ({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.6-luna" }),
    streamSimple: vi.fn(),
  })),
}));

import { runProposalTask } from "../src/task-run.js";
import { runPiTask } from "../src/integrations/pi-task.js";

const grant = {
  kind: "typescript-change" as const,
  proposalId: "b0e37d7c-f19f-4c0c-915c-e52aafea93e7",
  proposalSha256: "b".repeat(64),
  source: process.cwd(),
  baseline: "a".repeat(40),
  objective: "Change the value.",
  completionConditions: ["The new value is exported."],
  readFiles: ["src/value.ts"],
  writeFiles: ["src/value.ts"],
  declaredChecks: ["scope-integrity", "typescript-no-emit/v1"] as const,
  verification: { scopeIntegrity: "application_owned" as const, typecheck: "typescript-no-emit/v1" as const,
    outcome: "human_review_required" as const },
};

function piResult(settlement: PiTaskResult["settlement"], status: PiTaskResult["status"]): PiTaskResult {
  return { status, settlement, modelInvocations: 1, toolCalls: 1, edits: 0, checks: [], checksSuppliedToModel: 0,
    finalCheckSuppliedToModel: false, deadlineExpired: false, denied: false, terminalStopReason: "stop",
    taskAcceptance: "not_evaluated", executionCause: "initial_implementation", activeMs: 100, editCauses: [] };
}

function check(settlement: CandidateTaskCheck["settlement"]): CandidateTaskCheck {
  return { task: "typescript-change", status: "check_failed", outcome: "operational_failed", settlement,
    provenance: "recorded_untrusted", diagnostics: ["settlement unconfirmed"], typecheck: null, sourceInputsSha256: "d".repeat(64),
    baseline: "a".repeat(40), writeSetSha256: "c".repeat(64), taskAcceptance: "not_evaluated" };
}

function correctionRequest() {
  const parent = currentCheck.value;
  if (parent === null) throw new Error("Missing parent evidence fixture");
  return { refinement: "Change wording.", parentReviewSha256: "a".repeat(64),
    parentWriteSetSha256: parent.writeSetSha256,
    parentCheckSha256: createHash("sha256").update(JSON.stringify(parent)).digest("hex") };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.failure = null; state.writes = []; state.writeCalls = 0; state.syncCalls = 0;
  state.usage = { reads: 0, edits: 0, checks: 0 }; state.budget = null;
  state.r1Failure = null;
  state.beginExecutions = 0;
  parentAdmission.calls = 0; parentAdmission.pauseOnCall = 0;
  parentAdmission.entered = null; parentAdmission.release = null;
  parentAdmission.candidateIdentity = "candidate-r0"; parentAdmission.attemptIdentity = "attempt-r0";
  parentAdmission.checkIdentity = "check-r0"; parentAdmission.admittedIdentity = "";
  session.value = piResult("observed", "completed");
  currentCheck.value = check("unconfirmed");
});

it.runIf(process.platform === "win32").each(["read", "edit", "check", "model", "tool", "time"] as const)(
  "denies R1 before provider dispatch when the cumulative %s budget is exhausted", async (resource) => {
    currentCheck.value = { ...check("observed"), status: "passed", outcome: "passed", diagnostics: ["passed"] };
    session.value = piResult("observed", "completed");
    if (resource === "read") state.usage.reads = 8;
    if (resource === "edit") state.usage.edits = 2;
    if (resource === "check") state.usage.checks = 3;
    if (resource === "model" || resource === "tool" || resource === "time") state.budget = resource;
    const result = await runProposalTask(grant, { write: () => {}, writeError: () => {} });
    expect(result.status).toBe("passed");
    expect(result.correction?.available()).toBe(false);
    await expect(result.correction?.run({ refinement: "Change wording.", parentReviewSha256: "a".repeat(64),
      parentWriteSetSha256: "b".repeat(64), parentCheckSha256: "c".repeat(64) })).rejects.toThrow("budget");
    expect(vi.mocked(runPiTask)).toHaveBeenCalledTimes(1);
  },
);

it.runIf(process.platform === "win32")("uses the same cumulative ledger for a fresh R1 Pi agent", async () => {
  currentCheck.value = { ...check("observed"), status: "passed", outcome: "passed", diagnostics: ["passed"] };
  session.value = piResult("observed", "completed");
  const initial = await runProposalTask(grant, { write: () => {}, writeError: () => {} });
  const revised = await initial.correction?.run(correctionRequest());
  expect(revised?.status).toBe("passed");
  expect(initial.accounting.resources?.hostChecks).toBe(1);
  expect(revised?.accounting.resources?.hostChecks).toBe(2);
  const calls = vi.mocked(runPiTask).mock.calls;
  expect(calls).toHaveLength(2);
  expect(calls[1]?.[4]).toBe(calls[0]?.[4]);
});

it.runIf(process.platform === "win32")("denies mismatched live R0 parent evidence before R1 provider dispatch", async () => {
  currentCheck.value = { ...check("observed"), status: "passed", outcome: "passed", diagnostics: ["passed"] };
  session.value = piResult("observed", "completed");
  const initial = await runProposalTask(grant, { write: () => {}, writeError: () => {} });

  await expect(initial.correction?.run({ ...correctionRequest(), parentCheckSha256: "f".repeat(64) }))
    .rejects.toThrow("parent evidence");
  expect(vi.mocked(runPiTask)).toHaveBeenCalledTimes(1);
});

it.runIf(process.platform === "win32").each([
  "candidate/result bytes", "retained R0 diff/attempt lineage", "applicable check/source/configuration",
] as const)("revalidates %s after approval and denies stale R1 before dispatch", async (boundary) => {
  currentCheck.value = { ...check("observed"), status: "passed", outcome: "passed", diagnostics: ["passed"] };
  session.value = piResult("observed", "completed");
  const initial = await runProposalTask(grant, { write: () => {}, writeError: () => {} });
  let markEntered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  parentAdmission.pauseOnCall = 2;
  parentAdmission.entered = () => { markEntered?.(); };
  parentAdmission.release = released;

  const running = initial.correction?.run(correctionRequest());
  await entered;
  if (boundary === "candidate/result bytes") parentAdmission.candidateIdentity = "candidate-r0-drifted";
  if (boundary === "retained R0 diff/attempt lineage") parentAdmission.attemptIdentity = "attempt-r0-drifted";
  if (boundary === "applicable check/source/configuration") parentAdmission.checkIdentity = "check-r0-drifted";
  release?.();

  await expect(running).resolves.toMatchObject({ status: "failed", correction: null });
  expect(vi.mocked(runPiTask)).toHaveBeenCalledTimes(1);
  expect(state.beginExecutions).toBe(1);
  expect(state.writes.filter((record) => record.includes('"state":"finished"')).at(-1))
    .toContain('"outcome":"failed"');
});

it.runIf(process.platform === "win32").each(["write", "sync", "close"] as const)(
  "does not authorize review after an R1 attempt %s failure", async (failure) => {
    currentCheck.value = { ...check("observed"), status: "passed", outcome: "passed", diagnostics: ["passed"] };
    session.value = piResult("observed", "completed");
    const initial = await runProposalTask(grant, { write: () => {}, writeError: () => {} });
    expect(initial.status).toBe("passed");
    state.r1Failure = failure;
    const revised = await initial.correction?.run(correctionRequest());
    expect(revised?.status).toBe("failed");
    expect(revised?.correction).toBeNull();
  },
);

it.runIf(process.platform === "win32")("lets an unconfirmed final check dominate an observed Pi session", async () => {
  const result = await runProposalTask(grant, { write: () => {}, writeError: () => {} });

  expect(result.status).toBe("unsettled");
  expect(state.writes.join("")).toContain('"outcome":"unsettled"');
});

describe.runIf(process.platform === "win32").each(["write", "sync", "close"] as const)("final evidence %s failure", (failure) => {
  it("does not erase previously observed execution uncertainty", async () => {
    state.failure = failure;
    session.value = piResult("unconfirmed", "unsettled");
    currentCheck.value = null;

    const result = await runProposalTask(grant, { write: () => {}, writeError: () => {} });

    expect(result.status).toBe("unsettled");
    expect(result.accounting.modelInvocations).toBe(1);
  });
});
