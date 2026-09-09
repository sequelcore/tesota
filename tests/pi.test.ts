import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import * as piAi from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/pi-ai";
import { runPiSession } from "../src/integrations/pi.js";
import { DurableVerificationEvidenceStore } from "../src/verification/evidence.js";
import { configuredOxlint, runOxlint } from "../src/verification/oxlint.js";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof piAi>();
  return { ...actual, fauxProvider: vi.fn(actual.fauxProvider) };
});
const actualPi = await vi.importActual<typeof piAi>("@earendil-works/pi-ai");

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5_000,
}).trim();
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(piAi.fauxProvider).mockImplementation(actualPi.fauxProvider);
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

it("keeps the faux turn active until Pi processes abort and observes its terminal outcome", async () => {
  const { file, check } = await fixture();
  const contexts = observeModelContexts();
  const originalAbort = Agent.prototype.abort;
  let requested: (agent: Agent) => void = () => {};
  const request = new Promise<Agent>((resolve) => { requested = resolve; });
  vi.spyOn(Agent.prototype, "abort").mockImplementation(function (this: Agent) {
    requested(this);
  });
  let settled = false;
  const running = runPiSession({ check, input: file, scenario: "abort" });
  void running.then(() => { settled = true; });
  const activeAgent = await request;
  try {
    expect(contexts).toHaveLength(1);
    expect(activeAgent.state.isStreaming).toBe(true);
    expect(settled).toBe(false);
    expect(activeAgent.state.messages.some((message) =>
      message.role === "assistant" && message.stopReason === "aborted")).toBe(false);
  } finally {
    originalAbort.call(activeAgent);
    await running;
  }
  const result = await running;
  expect(result.abortRequested).toBe(true);
  expect(result.terminalStopReason).toBe("aborted");
  expect(result.status).toBe("aborted");
  expect(result.events.map((event) => event.type)).toEqual([
    "session_started", "turn_started", "abort_requested", "turn_completed", "session_aborted",
  ]);
  expect(activeAgent.state.isStreaming).toBe(false);
});

it("does not infer aborted from a request when faux abort processing is bypassed", async () => {
  const { file, check } = await fixture();
  const original = actualPi.fauxProvider;
  vi.mocked(piAi.fauxProvider).mockImplementation((options) => {
    const faux = original(options);
    const stream = faux.provider.streamSimple;
    // Let the factory process Pi's signal, but bypass the faux streamer's abort
    // behavior: a normal terminal message must not be relabelled by Tesota.
    faux.provider.streamSimple = (model, context, streamOptions) => {
      const signal = streamOptions?.signal;
      if (signal === undefined) throw new Error("Expected Pi abort signal");
      const detached = new AbortController().signal;
      let reads = 0;
      return stream(model, context, {
        ...streamOptions,
        get signal() { return reads++ === 0 ? signal : detached; },
      });
    };
    return faux;
  });
  const result = await runPiSession({ check, input: file, scenario: "abort" });
  expect(result.abortRequested).toBe(true);
  expect(result.terminalStopReason).toBe("stop");
  expect(result.status).toBe("completed");
  expect(result.events).not.toContainEqual({ type: "session_aborted", reason: "aborted" });
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

/** Capture the actual model-facing context, including any accidental extra fields. */
function observeModelContexts(toolResults?: unknown[]): Context[] {
  if (toolResults !== undefined) {
    const subscribe = Agent.prototype.subscribe;
    vi.spyOn(Agent.prototype, "subscribe").mockImplementation(function (this: Agent, listener) {
      return subscribe.call(this, (event, signal) => {
        if (event.type === "tool_execution_end") toolResults.push(event.result);
        return listener(event, signal);
      });
    });
  }
  const contexts: Context[] = [];
  const original = actualPi.fauxProvider;
  vi.mocked(piAi.fauxProvider).mockImplementation((options) => {
    const faux = original(options);
    const stream = faux.provider.streamSimple;
    faux.provider.streamSimple = (model, context, streamOptions) => {
      contexts.push({ ...context, messages: structuredClone(context.messages) });
      return stream(model, context, streamOptions);
    };
    return faux;
  });
  return contexts;
}

it.each([
  ["passed", "export const value = 1;\n", "Tesota verification passed; diagnostics=0", false],
  ["check_failed", "debugger;\ndebugger;\n", "Tesota verification check_failed; diagnostics=2", false],
  ["execution_failed", "export const value = 1;\n", "Tesota verification execution_failed", false],
  ["denied", "export const value = 1;\n", "Tesota did not admit this verification action.", true],
] as const)("exposes exactly the bounded %s projection to Pi", async (status, source, text, denied) => {
  const { file, check } = await fixture(source);
  const toolResults: unknown[] = [];
  const contexts = observeModelContexts(toolResults);
  const executor = vi.fn(status === "execution_failed"
    ? async () => ({ status: "execution_failed" as const, reason: "PRIVATE_REASON", process: "unconfirmed" as const,
      pid: 123, retainedDirectory: "PRIVATE_DIRECTORY" })
    : runOxlint);
  const result = await runPiSession({
    check, input: file, scenario: "verification_request",
    admitVerification: !denied, verificationExecutor: executor,
  });
  expect(result.status).toBe("completed");
  expect(contexts).toHaveLength(2);
  expect(executor).toHaveBeenCalledTimes(denied ? 0 : 1);
  const messages = contexts.flatMap((context) => context.messages);
  const calls = messages.flatMap((message) => message.role === "assistant"
    ? message.content.filter((block) => block.type === "toolCall") : []);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toStrictEqual({ type: "toolCall", id: expect.any(String), name: "tesota_verify", arguments: { input: file } });
  expect(toolResults).toStrictEqual([{
    content: [{ type: "text", text }], details: denied ? {} : { status },
  }]);
  const results = messages.filter((message) => message.role === "toolResult");
  expect(results).toStrictEqual([{
    role: "toolResult", toolCallId: calls[0]?.id, toolName: "tesota_verify",
    content: [{ type: "text", text }],
    details: denied ? {} : { status },
    usage: undefined, isError: denied, timestamp: expect.any(Number),
  }]);
  // Exact context/message shapes above reject additional evidence or diagnostics;
  // the canonical evidence remains available only on the Tesota return value.
  if (status === "passed" || status === "check_failed") {
    expect(result.issuedEvidence).toBe(result.verification);
    expect(result.issuedEvidence?.diagnostics).toHaveLength(status === "passed" ? 0 : 2);
    expect(result.issuedEvidence?.binding).toBeDefined();
  }
});
