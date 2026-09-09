import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { browserOnlyAuth, LIVE_CODEX_EXPECTED_TOKEN, LIVE_LIMITS, liveProbePasses,
  runLiveCodexTurn, type LiveCodexTurnResult } from "../src/integrations/pi-live.js";
import { serializeLiveEvidence } from "../src/integrations/pi-live-evidence.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function controlled(abortProbe = false) {
  vi.useFakeTimers();
  const model = fauxProvider({ models: [{ id: "offline", name: "Offline" }] }).getModel();
  const stream = createAssistantMessageEventStream();
  let opened: (signal: AbortSignal) => void = () => {};
  const started = new Promise<AbortSignal>((resolve) => { opened = resolve; });
  let calls = 0;
  const invoke = vi.fn<StreamFn>((_model, context, options) => {
    expect(context.tools).toEqual([]);
    expect(options).toMatchObject({ maxRetries: 0, transport: "sse", maxTokens: 64 });
    if (options?.signal === undefined) throw new Error("Missing Pi signal");
    opened(options.signal);
    // If the budget guard is mutated away, let the forbidden continuation settle
    // normally so the regression fails on invocation count rather than hanging.
    if (++calls > 1) {
      const extra = createAssistantMessageEventStream();
      const message = fauxAssistantMessage(LIVE_CODEX_EXPECTED_TOKEN);
      extra.push({ type: "done", reason: "stop", message });
      extra.end(message);
      return extra;
    }
    return stream;
  });
  const running = runLiveCodexTurn(invoke, model, abortProbe);
  const partial = fauxAssistantMessage("partial");
  function update() {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
  }
  function finish(reason: "stop" | "aborted" = "stop") {
    const message = { ...fauxAssistantMessage(LIVE_CODEX_EXPECTED_TOKEN), stopReason: reason };
    if (reason === "aborted") stream.push({ type: "error", reason, error: message });
    else stream.push({ type: "done", reason, message });
    stream.end(message);
  }
  return { stream, started, invoke, running, update, finish };
}

it("accepts an independently observed normal fixed response", async () => {
  const turn = controlled();
  await turn.started;
  turn.finish();
  const result = await turn.running;
  expect(liveProbePasses(result, false)).toBe(true);
  expect(liveProbePasses(result, true)).toBe(false);
  expect(result.modelInvocationCount).toBe(1);
  expect(result.events).toEqual(["session_started", "turn_started", "model_invocation_started",
    "turn_completed", "terminal_stop", "normalized_completed"]);
});

it("prevents Pi's nonexistent-tool continuation before a second provider invocation", async () => {
  const turn = controlled();
  await turn.started;
  const message = fauxAssistantMessage(fauxToolCall("nonexistent", {}));
  turn.stream.push({ type: "done", reason: "toolUse", message });
  turn.stream.end(message);
  const result = await turn.running;
  expect(turn.invoke).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ modelInvocationCount: 1, invocationAttempts: 2,
    requestBudgetExceeded: true, toolExecutionStartCount: 1, status: "failed" });
  expect(liveProbePasses(result, false)).toBe(false);
  expect(liveProbePasses(result, true)).toBe(false);
});

it("bounds a never-settling streamed body and leaves abort without settlement unconfirmed", async () => {
  const turn = controlled();
  const signal = await turn.started;
  let returned = false;
  void turn.running.then(() => { returned = true; });
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.turnMs);
  expect(signal.aborted).toBe(true);
  expect(returned).toBe(false);
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.settlementMs);
  const result = await turn.running;
  expect(result).toMatchObject({ status: "unsettled", settlement: "unconfirmed",
    terminalObserved: false, terminalStopReason: null, abortRequested: true, deadlineExpired: true });
  expect(result.events.slice(-3)).toEqual(["deadline_expired", "abort_requested", "settlement_unconfirmed"]);
  expect(liveProbePasses(result, false)).toBe(false);
  turn.finish("aborted");
  // Late events must not retroactively upgrade the returned evidence.
  await vi.advanceTimersByTimeAsync(0);
  expect(result.status).toBe("unsettled");
  expect(result.events).not.toContain("terminal_aborted");
});

it("records Pi terminal aborted after a deadline without claiming probe success", async () => {
  const turn = controlled();
  const signal = await turn.started;
  signal.addEventListener("abort", () => turn.finish("aborted"), { once: true });
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.turnMs);
  const result = await turn.running;
  expect(result).toMatchObject({ status: "aborted", terminalStopReason: "aborted",
    terminalObserved: true, settlement: "observed", abortRequested: true, deadlineExpired: true });
  expect(result.events.slice(-5)).toEqual(["deadline_expired", "abort_requested",
    "turn_completed", "terminal_aborted", "normalized_aborted"]);
  expect(liveProbePasses(result, true)).toBe(false);
});

it("requires update then abort request then Pi terminal aborted", async () => {
  const turn = controlled(true);
  const signal = await turn.started;
  expect(signal.aborted).toBe(false);
  signal.addEventListener("abort", () => turn.finish("aborted"), { once: true });
  turn.update();
  const result = await turn.running;
  expect(liveProbePasses(result, true)).toBe(true);
  expect(result.events).toEqual(["session_started", "turn_started", "model_invocation_started",
    "stream_update", "abort_requested", "turn_completed", "terminal_aborted", "normalized_aborted"]);
});

it("fails an ineffective Agent.abort mutation within the settlement window", async () => {
  vi.spyOn(Agent.prototype, "abort").mockImplementation(() => {});
  const turn = controlled(true);
  const signal = await turn.started;
  signal.addEventListener("abort", () => turn.finish("aborted"), { once: true });
  turn.update();
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.settlementMs);
  const result = await turn.running;
  expect(result.status).toBe("unsettled");
  expect(result.abortRequested).toBe(true);
  expect(signal.aborted).toBe(false);
  expect(liveProbePasses(result, true)).toBe(false);
  turn.finish();
});

it("fails when Pi completes normally after the abort request", async () => {
  const turn = controlled(true);
  const signal = await turn.started;
  signal.addEventListener("abort", () => turn.finish("stop"), { once: true });
  turn.update();
  const result = await turn.running;
  expect(result.status).toBe("completed");
  expect(result.abortRequested).toBe(true);
  expect(liveProbePasses(result, true)).toBe(false);
});

async function successfulAbort() {
  const turn = controlled(true);
  const signal = await turn.started;
  signal.addEventListener("abort", () => turn.finish("aborted"), { once: true });
  turn.update();
  return turn.running;
}

it("rejects missing or wrongly ordered abort assertions independently", async () => {
  const probe = await successfulAbort();
  const mutations: Partial<LiveCodexTurnResult>[] = [
    { events: ["abort_requested", ...probe.events.filter((event) => event !== "abort_requested")] },
    { streamUpdateCount: 0 }, { abortRequested: false }, { terminalObserved: false },
    { status: "completed" }, { terminalStopReason: "stop" }, { settlement: "unconfirmed" },
    { modelInvocationCount: 0 }, { modelInvocationCount: 2 }, { invocationAttempts: 2 },
    { requestBudgetExceeded: true }, { toolExecutionStartCount: 1 },
    { events: probe.events.filter((event) => event !== "normalized_aborted") },
    { events: [...probe.events, "tool_execution_started"] },
  ];
  for (const mutation of mutations) expect(liveProbePasses({ ...probe, ...mutation }, true)).toBe(false);
});

it("never reads or prints manual authorization material; callback cancellation settles the prompt", async () => {
  const openBrowser = vi.fn();
  const log = vi.spyOn(console, "log");
  const abort = new AbortController();
  const callback = new AbortController();
  const auth = browserOnlyAuth(openBrowser, abort.signal);
  expect(await auth.prompt({ type: "select", message: "login", options: [{ id: "browser", label: "Browser" }] })).toBe("browser");
  let returned = false;
  const prompt = auth.prompt({ type: "manual_code", message: "SYNTHETIC_PROMPT", signal: callback.signal });
  const rejected = expect(prompt).rejects.toThrow("Browser callback input closed");
  void prompt.then(() => { returned = true; }, () => {});
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(log).not.toHaveBeenCalled();
  callback.abort();
  await rejected;
  await expect(auth.prompt({ type: "secret", message: "SYNTHETIC_PROMPT" })).rejects.toThrow("Manual authorization input is disabled");
  await expect(auth.prompt({ type: "text", message: "SYNTHETIC_PROMPT" })).rejects.toThrow("Manual authorization input is disabled");
  await expect(auth.prompt({ type: "manual_code", message: "SYNTHETIC_PROMPT" })).rejects.toThrow("Manual authorization input is disabled");
  auth.notify({ type: "info", message: "SYNTHETIC_PRIVATE_MESSAGE" });
  auth.notify({ type: "progress", message: "SYNTHETIC_PRIVATE_MESSAGE" });
  expect(log).not.toHaveBeenCalled();
  expect(openBrowser).not.toHaveBeenCalled();
});

it("retains only the exact versioned evidence shape, and neither probe can hide failure", async () => {
  const abortProbe = await successfulAbort();
  const turn = controlled();
  await turn.started;
  turn.finish();
  const normal = await turn.running;
  const extra = { ...abortProbe, headers: "SYNTHETIC_PRIVATE", response: "SYNTHETIC_PRIVATE",
    tokens: "SYNTHETIC_PRIVATE", error: "SYNTHETIC_PRIVATE" };
  const serialized = serializeLiveEvidence({}, "2026-01-01T00:00:00.000Z", { turn: normal, abortProbe: extra });
  expect(serialized).not.toContain("SYNTHETIC_PRIVATE");
  const evidence = JSON.parse(serialized);
  expect(Object.keys(evidence).sort()).toEqual(["format", "version", "provenance", "timestamp", "implementation",
    "provider", "api", "model", "authType", "limits", "modelInvocationCount", "turn", "abortProbe", "disposition"].sort());
  expect(Object.keys(evidence.abortProbe).sort()).toEqual(["status", "modelInvocationCount", "invocationAttempts",
    "toolExecutionStartCount", "streamUpdateCount", "terminalStopReason", "terminalObserved", "abortRequested",
    "taskAcceptance", "responseMatchesExpectedToken", "requestBudgetExceeded", "deadlineExpired", "settlement",
    "events", "requestBoundRespected", "turnBoundRespected", "disposition"].sort());
  expect(evidence.disposition).toBe("passed");
  for (const result of [
    { turn: { ...normal, responseMatchesExpectedToken: false }, abortProbe },
    { turn: normal, abortProbe: { ...abortProbe, terminalObserved: false } },
    { turn: normal, abortProbe: null },
  ]) expect(JSON.parse(serializeLiveEvidence({}, "2026-01-01T00:00:00.000Z", result)).disposition).toBe("failed");
});

it("compiled live help is offline and never opens an authorization input path", () => {
  const output = execFileSync("bun", ["--no-env-file", "dist/live-codex.js", "--help"], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  expect(output).toContain("browser OAuth callback only");
});
