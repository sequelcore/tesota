import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateCheckout } from "../src/candidate-checkout.js";
import type { CandidateTask, CandidateTaskCheck } from "../src/candidate-task.js";
import type { PiTaskResult } from "../src/integrations/pi-task.js";

const roots: string[] = [];
const state = vi.hoisted(() => ({
  admission: "unconfirmed" as "unconfirmed" | "stale",
  attemptFailure: null as null | "write" | "sync" | "close",
  candidate: null as CandidateCheckout | null, candidatesRoot: "", checkCalls: 0,
  sessionChecks: [] as CandidateTaskCheck[], beginExecutions: 0,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original,
    readFile: vi.fn(async (path: Parameters<typeof original.readFile>[0], options?: Parameters<typeof original.readFile>[1]) =>
      path instanceof URL ? Buffer.from("executor") : original.readFile(path, options as never)),
    open: vi.fn(async (path: string, flags: string | number, mode?: number) => {
      const handle = await original.open(path, flags, mode);
      if (!path.endsWith("attempt-r1.partial") || state.attemptFailure === null) return handle;
      let writes = 0; let syncs = 0;
      return { ...handle,
        writeFile: async (value: string) => {
          writes += 1;
          if (state.attemptFailure === "write" && writes === 2) throw new Error("synthetic attempt write failure");
          await handle.writeFile(value);
        },
        sync: async () => {
          syncs += 1;
          if (state.attemptFailure === "sync" && syncs === 2) throw new Error("synthetic attempt sync failure");
          await handle.sync();
        },
        close: async () => {
          await handle.close();
          if (state.attemptFailure === "close") throw new Error("synthetic attempt close failure");
        },
      };
    }),
  };
});

vi.mock("../src/candidate-checkout.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/candidate-checkout.js")>();
  return { ...original, createCandidateCheckout: vi.fn(async (source: string) => {
    const candidate = await original.createCandidateCheckout(source, state.candidatesRoot);
    state.candidate = candidate;
    return candidate;
  }) };
});

vi.mock("../src/candidate-task.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/candidate-task.js")>();
  return { ...original,
    CandidateTask: { prepare: vi.fn(async (directory: string, grant: Parameters<typeof original.CandidateTask.prepare>[1]) => {
      const task = await original.CandidateTask.prepare(directory, grant);
      return { beginExecution: vi.fn(() => {
        state.beginExecutions += 1;
        return { close: vi.fn() };
      }), usage: vi.fn(() => ({ reads: 1, edits: 1, checks: 1 })),
      describe: () => task.describe(), close: () => task.close() } as unknown as CandidateTask;
    }) },
    checkCandidateTask: vi.fn(async (directory: string) => {
    state.checkCalls += 1;
    if (state.candidate === null) throw new Error("Missing candidate fixture");
    const plan = JSON.parse(await readFile(join(directory, "task.json"), "utf8")) as { readonly sourceInputs: unknown };
    const content = await readFile(join(state.candidate.checkout, "src", "value.ts"), "utf8");
    const observed: CandidateTaskCheck = { task: "typescript-change", status: "passed", outcome: "passed",
      settlement: "observed", provenance: "recorded_untrusted", diagnostics: ["passed"],
      typecheck: { profile: "typescript-no-emit/v1", status: "passed", reason: null, diagnostics: [], process: "exited",
        container: "absent", binding: {} as never, authority: "none", provenance: "issued" },
      sourceInputsSha256: createHash("sha256").update(JSON.stringify(plan.sourceInputs)).digest("hex"),
      baseline: state.candidate.baseline,
      writeSetSha256: original.taskWriteSetSha256({ "src/value.ts": content }, ["src/value.ts"]),
      taskAcceptance: "not_evaluated" };
    if (state.checkCalls === 1) state.sessionChecks.push(
      { ...observed, status: "check_failed", outcome: "check_failed", diagnostics: ["initial failure"],
        provenance: "issued" },
      { ...observed, provenance: "issued" },
    );
    if (state.checkCalls !== 8) return observed;
    if (state.admission === "stale") throw new Error("Semantic correction parent evidence invalid");
    return { ...observed, status: "check_failed", outcome: "operational_failed", settlement: "unconfirmed",
      diagnostics: ["settlement unconfirmed"] };
  }) };
});

vi.mock("../src/integrations/pi-task.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/integrations/pi-task.js")>();
  return { ...original,
    runPiTask: vi.fn(async (_task, _model, _stream, _signal, budget) => {
      if (state.candidate === null) throw new Error("Missing candidate fixture");
      await writeFile(join(state.candidate.checkout, "src", "value.ts"), "export const value = 'new';\n");
      budget.modelInvocations += 1; budget.toolCalls += 2;
      return { status: "completed", settlement: "observed", modelInvocations: 1, toolCalls: 2, edits: 1,
        checks: state.sessionChecks, checksSuppliedToModel: 2, finalCheckSuppliedToModel: true,
        deadlineExpired: false, denied: false, terminalStopReason: "stop", taskAcceptance: "not_evaluated",
        executionCause: "initial_implementation", activeMs: 100,
        editCauses: [{ cause: "initial_implementation" }] } satisfies PiTaskResult;
    }),
    piTaskPasses: vi.fn(() => true), piSemanticRevisionPasses: vi.fn(() => true),
  };
});

const provider = vi.hoisted(() => ({ streamSimple: vi.fn() }));
vi.mock("../src/integrations/pi-live.js", () => ({
  LIVE_CODEX_MODEL_ID: "gpt-6-luna",
  storedCodexModels: vi.fn(async () => ({
    getModel: () => ({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" }),
    streamSimple: provider.streamSimple,
  })),
}));

import { runPiTask } from "../src/integrations/pi-task.js";
import { runProposalTask } from "../src/task-run.js";
import { startTask } from "../src/task-start.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
beforeEach(() => {
  vi.clearAllMocks(); state.admission = "unconfirmed"; state.attemptFailure = null; state.candidate = null;
  state.candidatesRoot = ""; state.checkCalls = 0; state.sessionChecks = []; state.beginExecutions = 0;
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    { cwd, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) throw new Error(result.stderr || "Fixture Git failed");
  return result.stdout.trim();
}

async function fixture(): Promise<{ readonly proposal: string; readonly proposalId: string; readonly source: string;
  readonly proposalsRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "tesota-admission-settlement-"));
  roots.push(root);
  const source = join(root, "source"); const proposalsRoot = join(root, "proposals");
  const proposalId = "9877887d-1475-4439-a0a6-c1c85091fc9e"; const proposal = join(proposalsRoot, proposalId);
  state.candidatesRoot = join(root, "candidates");
  await mkdir(join(source, "src"), { recursive: true });
  await writeFile(join(source, "src", "value.ts"), "export const value = 'old';\n");
  git(source, ["init", "--quiet"]); git(source, ["add", "."]);
  git(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit",
    "--quiet", "--no-gpg-sign", "-m", "Fixture"]);
  const baseline = git(source, ["rev-parse", "HEAD"]);
  await mkdir(proposal, { recursive: true });
  await writeFile(join(proposal, "proposal.json"), JSON.stringify({
    format: "tesota-task-proposal", version: 1, id: proposalId, recordedAt: new Date().toISOString(), source, baseline,
    request: "Change the value.", authority: "none", provenance: "model_proposed", status: "ready",
    proposal: { objective: "Change the exported value.", completionConditions: ["The new value is exported."],
      readFiles: ["src/value.ts"], writeFiles: ["src/value.ts"],
      checks: ["scope-integrity", "typescript-no-emit/v1"], uncertainties: [] },
    dirtyPaths: [], dirtyConflicts: [], checks: [{ id: "scope-integrity",
      definition: "application_owned_declarative_only", executable: false }, { id: "typescript-no-emit/v1",
      definition: "application_owned_declarative_only", executable: false }],
    discovery: { provider: "test", model: "test", inferenceTransport: "configured_provider",
      modelControlledNetwork: false, modelInvocations: 1, toolCalls: 1, operations: 1, exposedBytes: 8,
      limits: { operations: 24, listedFiles: 256, searchMatches: 64, fileBytes: 65536,
        scannedBytes: 524288, exposedBytes: 262144 } },
  }, null, 2) + "\n");
  return { proposal, proposalId, source, proposalsRoot };
}

async function runCorrection() {
  const current = await fixture();
  const decide = vi.fn(); const promote = vi.fn(); const output: string[] = [];
  const result = await startTask({ proposalsRoot: current.proposalsRoot, sourceDirectory: current.source,
    reference: current.proposalId,
    ask: vi.fn().mockResolvedValueOnce("yes").mockResolvedValueOnce("c")
      .mockResolvedValueOnce("Use the alternate wording.").mockResolvedValueOnce("yes"),
    write: (text) => output.push(text), decide, promote,
    execute: (grant) => runProposalTask(grant, { write: () => {}, writeError: () => {} }) });
  if (state.candidate === null) throw new Error("Candidate was not created");
  return { ...current, candidate: state.candidate, decide, promote, output, result };
}

it.runIf(process.platform === "win32")(
  "preserves final correction-admission uncertainty through attempt and task start without R1 dispatch", async () => {
    const current = await runCorrection();
    expect(state.checkCalls).toBe(8);
    expect(current.result).toEqual({ status: "unsettled", exitCode: 1, outcome: "execution_unconfirmed" });
    expect(vi.mocked(runPiTask)).toHaveBeenCalledTimes(1); expect(state.beginExecutions).toBe(1);
    expect(provider.streamSimple).not.toHaveBeenCalled();
    expect(current.decide).not.toHaveBeenCalled(); expect(current.promote).not.toHaveBeenCalled();
    const attempt = await readFile(join(current.candidate.directory, "attempt-r1.jsonl"), "utf8");
    expect(attempt).toContain('"outcome":"unsettled"'); expect(attempt).toContain('"settlement":"unconfirmed"');
    const start = await readFile(join(current.proposal, "start.jsonl"), "utf8");
    expect(start).toContain('"state":"revision_started"'); expect(start).not.toContain('"state":"revision_finished"');
    expect(start).not.toContain('"state":"finished"');
    expect(current.output.join("")).toContain("Semantic revision settlement is unconfirmed");
  });

it.runIf(process.platform === "win32")(
  "keeps an ordinary settled stale-parent rejection distinct from uncertain admission effects", async () => {
    state.admission = "stale";
    const current = await runCorrection();
    expect(current.result).toEqual({ status: "settled", exitCode: 1, outcome: "execution_failed" });
    expect(vi.mocked(runPiTask)).toHaveBeenCalledTimes(1); expect(state.beginExecutions).toBe(1);
    expect(current.decide).not.toHaveBeenCalled(); expect(current.promote).not.toHaveBeenCalled();
    expect(await readFile(join(current.candidate.directory, "attempt-r1.jsonl"), "utf8"))
      .toContain('"outcome":"failed"');
  });

describe.runIf(process.platform === "win32").each(["write", "sync", "close"] as const)(
  "R1 attempt evidence %s failure", (failure) => {
    it("cannot erase already observed admission uncertainty", async () => {
      state.attemptFailure = failure;
      const current = await runCorrection();
      expect(current.result).toEqual({ status: "unsettled", exitCode: 1, outcome: "execution_unconfirmed" });
      expect(vi.mocked(runPiTask)).toHaveBeenCalledTimes(1); expect(state.beginExecutions).toBe(1);
      expect(current.decide).not.toHaveBeenCalled(); expect(current.promote).not.toHaveBeenCalled();
    });
  });
