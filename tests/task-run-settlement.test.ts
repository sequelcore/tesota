import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateTask, CandidateTaskCheck } from "../src/candidate-task.js";
import type { PiTaskResult } from "../src/integrations/pi-task.js";

const state = vi.hoisted(() => ({
  failure: null as null | "write" | "sync" | "close",
  writes: [] as string[],
  writeCalls: 0,
  syncCalls: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original,
    readFile: vi.fn(async () => Buffer.from("executor")),
    writeFile: vi.fn(async () => {}),
    open: vi.fn(async () => ({
      writeFile: async (value: string) => {
        state.writeCalls += 1;
        if (state.failure === "write" && state.writeCalls === 2) throw new Error("synthetic final write failure");
        state.writes.push(value);
      },
      sync: async () => {
        state.syncCalls += 1;
        if (state.failure === "sync" && state.syncCalls === 2) throw new Error("synthetic final sync failure");
      },
      close: async () => {
        if (state.failure === "close") throw new Error("synthetic close failure");
      },
    })),
  };
});

vi.mock("../src/candidate-checkout.js", () => ({
  createCandidateCheckout: vi.fn(async () => ({ directory: "candidate", checkout: "candidate/repo",
    baseline: "a".repeat(40), sourceDirty: false })),
  candidateDiff: vi.fn(async () => "diff"),
}));

const currentCheck = vi.hoisted(() => ({ value: null as CandidateTaskCheck | null }));
vi.mock("../src/candidate-task.js", () => ({
  CandidateTask: { prepare: vi.fn(async () => ({ close: vi.fn() }) as unknown as CandidateTask) },
  checkCandidateTask: vi.fn(async () => currentCheck.value),
}));

const session = vi.hoisted(() => ({ value: null as PiTaskResult | null }));
vi.mock("../src/integrations/pi-task.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/integrations/pi-task.js")>();
  return { ...original, runPiTask: vi.fn(async () => session.value) };
});

vi.mock("../src/integrations/pi-live.js", () => ({
  LIVE_CODEX_MODEL_ID: "gpt-5.6-luna",
  storedCodexModels: vi.fn(async () => ({
    getModel: () => ({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-5.6-luna" }),
    streamSimple: vi.fn(),
  })),
}));

import { runProposalTask } from "../src/task-run.js";

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
    taskAcceptance: "not_evaluated" };
}

function check(settlement: CandidateTaskCheck["settlement"]): CandidateTaskCheck {
  return { task: "typescript-change", status: "check_failed", outcome: "operational_failed", settlement,
    provenance: "recorded_untrusted", diagnostics: ["settlement unconfirmed"], typecheck: null, sourceInputsSha256: "d".repeat(64),
    baseline: "a".repeat(40), writeSetSha256: "c".repeat(64), taskAcceptance: "not_evaluated" };
}

beforeEach(() => {
  state.failure = null; state.writes = []; state.writeCalls = 0; state.syncCalls = 0;
  session.value = piResult("observed", "completed");
  currentCheck.value = check("unconfirmed");
});

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
