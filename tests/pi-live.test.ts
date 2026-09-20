import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";
import { browserOnlyAuth, LIVE_CODEX_EXPECTED_TOKEN, LIVE_LIMITS, liveProbePasses,
  classifyLiveOAuthFailure, observeLiveBrowserLaunch, runLiveOAuthLogin, runLiveCodexTurn,
  type LiveCodexExperimentResult, type LiveCodexTurnResult } from "../src/integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence } from "../src/integrations/pi-live-evidence.js";

function experimentEvidence(result: LiveCodexExperimentResult): string {
  return serializeLiveEvidence(liveSourceIdentity(), "2026-01-01T00:00:00.000Z", {
    mode: "full_probe", authenticationMethod: "browser", authentication: { outcome: "succeeded", oauthFailureCategory: null },
    experiment: result, inferenceAttempted: false, disposition: "failed",
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function controlled(abortProbe = false) {
  vi.useFakeTimers();
  const model = fauxProvider({ models: [{ id: "offline", name: "Offline" }] }).getModel();
  const stream = createAssistantMessageEventStream();
  let opened: (signal: AbortSignal) => void = () => {};
  const started = new Promise<AbortSignal>((resolve) => { opened = resolve; });
  let calls = 0;
  const invoke = vi.fn<StreamFn>((_model, context, options) => {
    expect(getCurrentTools(context.messages)).toEqual([]);
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

it("ignores invalid HTTP status values without reading headers or changing completion", async () => {
  const turn = controlled();
  await turn.started;
  const call = turn.invoke.mock.calls[0];
  const onResponse = call?.[2]?.onResponse;
  if (call === undefined || onResponse === undefined) throw new Error("Missing response observer");
  for (const status of ["Bearer SYNTHETIC_PRIVATE", null, NaN, Infinity, 200.5, 99, 600]) {
    await Reflect.apply(onResponse, undefined, [{ status,
      get headers() { throw new Error("Headers must not be inspected"); },
    }, call[0]]);
  }
  turn.finish();
  const result = await turn.running;
  expect(result.providerDiagnostic).toEqual({ httpStatus: null, failureStage: null, providerErrorCode: null });
  expect(liveProbePasses(result, false)).toBe(true);
  await onResponse({ status: 403, headers: {} }, call[0]);
  expect(result.providerDiagnostic.httpStatus).toBeNull();
});

it.each<{ content: AssistantMessage["content"]; textCount: number; nonTextCount: number; textMatches: boolean; passes: boolean }>([
  { content: [{ type: "text", text: LIVE_CODEX_EXPECTED_TOKEN }], textCount: 1, nonTextCount: 0, textMatches: true, passes: true },
  { content: [{ type: "text", text: " TESOTA_" }, { type: "text", text: "CODEX_OK\n" }], textCount: 2, nonTextCount: 0, textMatches: true, passes: true },
  { content: [{ type: "text", text: "SYNTHETIC_PRIVATE" }], textCount: 1, nonTextCount: 0, textMatches: false, passes: false },
  { content: [{ type: "thinking", thinking: "SYNTHETIC_PRIVATE" }, { type: "text", text: LIVE_CODEX_EXPECTED_TOKEN }], textCount: 1, nonTextCount: 1, textMatches: true, passes: true },
  { content: [{ type: "thinking", thinking: "", thinkingSignature: "SYNTHETIC_PRIVATE" }, { type: "text", text: LIVE_CODEX_EXPECTED_TOKEN }], textCount: 1, nonTextCount: 1, textMatches: true, passes: true },
  { content: [{ type: "thinking", thinking: LIVE_CODEX_EXPECTED_TOKEN }, { type: "text", text: "SYNTHETIC_PRIVATE" }], textCount: 1, nonTextCount: 1, textMatches: false, passes: false },
  { content: [{ type: "thinking", thinking: "SYNTHETIC_PRIVATE" }], textCount: 0, nonTextCount: 1, textMatches: false, passes: false },
  { content: [], textCount: 0, nonTextCount: 0, textMatches: false, passes: false },
])("diagnoses response structure without retaining content: $textCount text, $nonTextCount other, match $textMatches", async ({ content, textCount, nonTextCount, textMatches, passes }) => {
  const turn = controlled();
  await turn.started;
  const message = { ...fauxAssistantMessage(""), content };
  turn.stream.push({ type: "done", reason: "stop", message });
  turn.stream.end(message);
  const result = await turn.running;
  expect(result.responseDiagnostic).toEqual({ messageObserved: true, textBlockCount: textCount,
    nonTextBlockCount: nonTextCount, thinkingBlockCount: nonTextCount, textMatchesExpectedToken: textMatches });
  expect(liveProbePasses(result, false)).toBe(passes);
  expect(experimentEvidence({ turn: result, abortProbe: null })).not.toContain("SYNTHETIC_PRIVATE");
});

it.each(["toolCall", "future_content"])("rejects %s alongside the expected text even with terminal stop", async (type) => {
  const turn = controlled();
  await turn.started;
  const message = fauxAssistantMessage(LIVE_CODEX_EXPECTED_TOKEN);
  const block = type === "toolCall" ? fauxToolCall("nonexistent", {}) :
    { type: "thinking" as const, thinking: "SYNTHETIC_PRIVATE" };
  if (type === "future_content") Reflect.set(block, "type", type);
  message.content.push(block);
  turn.stream.push({ type: "done", reason: "stop", message });
  turn.stream.end(message);
  const result = await turn.running;
  expect(result.responseMatchesExpectedToken).toBe(false);
  expect(liveProbePasses(result, false)).toBe(false);
  expect(experimentEvidence({ turn: result, abortProbe: null })).not.toContain("SYNTHETIC_PRIVATE");
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
  expect(result.responseDiagnostic).toEqual({ messageObserved: false, textBlockCount: 0,
    nonTextBlockCount: 0, thinkingBlockCount: 0, textMatchesExpectedToken: false });
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
    tokens: "SYNTHETIC_PRIVATE", error: "SYNTHETIC_PRIVATE",
    providerDiagnostic: { ...abortProbe.providerDiagnostic, headers: "SYNTHETIC_PRIVATE", body: "SYNTHETIC_PRIVATE" },
    responseDiagnostic: { ...abortProbe.responseDiagnostic, text: "SYNTHETIC_PRIVATE" } };
  const serialized = experimentEvidence({ turn: normal, abortProbe: extra });
  expect(serialized).not.toContain("SYNTHETIC_PRIVATE");
  const evidence = JSON.parse(serialized);
  expect(Object.keys(evidence).sort()).toEqual(["format", "version", "provenance", "timestamp", "implementation",
    "provider", "api", "model", "authType", "authenticationMethod", "mode", "authenticationOutcome", "inferenceAttempted", "limits", "oauthFailureCategory", "modelInvocationCount", "turn", "abortProbe", "disposition"].sort());
  expect(evidence).toMatchObject({ format: "tesota-codex-evidence", version: 9 });
  expect(evidence.oauthFailureCategory).toBeNull();
  expect(Object.keys(evidence.abortProbe).sort()).toEqual(["status", "modelInvocationCount", "invocationAttempts",
    "toolExecutionStartCount", "streamUpdateCount", "terminalStopReason", "terminalObserved", "abortRequested",
    "taskAcceptance", "responseMatchesExpectedToken", "responseDiagnostic", "requestBudgetExceeded", "deadlineExpired", "settlement",
    "events", "providerDiagnostic", "requestBoundRespected", "turnBoundRespected", "disposition"].sort());
  expect(evidence.disposition).toBe("passed");
  for (const result of [
    { turn: { ...normal, responseMatchesExpectedToken: false }, abortProbe },
    { turn: normal, abortProbe: { ...abortProbe, terminalObserved: false } },
    { turn: normal, abortProbe: null },
  ]) expect(JSON.parse(experimentEvidence(result)).disposition).toBe("failed");
});

function oauthFailureEvidence(error: unknown, category: string) {
  const failureCategory = classifyLiveOAuthFailure(error);
  const serialized = serializeLiveEvidence(liveSourceIdentity(), "2026-01-01T00:00:00.000Z", {
    mode: "auth_only", authenticationMethod: "browser", authentication: failureCategory === "oauth_timeout" ?
      { outcome: "unconfirmed", oauthFailureCategory: failureCategory } :
      { outcome: "failed", oauthFailureCategory: failureCategory },
    experiment: null, inferenceAttempted: false, disposition: "failed",
  });
  const evidence = JSON.parse(serialized);
  expect(evidence).toMatchObject({ version: 9, oauthFailureCategory: category,
    modelInvocationCount: 0, turn: null, abortProbe: null, disposition: "failed" });
  expect(serialized).not.toContain("SYNTHETIC_PRIVATE");
  expect(serialized).not.toContain("stack");
  expect(serialized).not.toContain("taskAcceptance");
  return evidence;
}

it("classifies the local OAuth deadline even when cancellation rejects login immediately", async () => {
  vi.useFakeTimers();
  const auth = browserOnlyAuth(vi.fn(), new AbortController().signal);
  let signal: AbortSignal | undefined;
  const running = runLiveOAuthLogin((interaction) => new Promise((_resolve, reject) => {
    signal = interaction.signal;
    signal?.addEventListener("abort", () => reject(new Error("SYNTHETIC_PRIVATE cancellation")), { once: true });
  }), auth).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.loginMs);
  oauthFailureEvidence(await running, "oauth_timeout");
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["throw", "error_event"])("classifies local browser launch %s without serializing its payload", async (mode) => {
  const cancellation = new AbortController();
  const auth = browserOnlyAuth(vi.fn(), cancellation.signal);
  const running = runLiveOAuthLogin((interaction) => new Promise((_resolve, reject) => {
    interaction.signal?.addEventListener("abort", () => reject(interaction.signal?.reason), { once: true });
  }), auth).catch((error: unknown) => error);
  observeLiveBrowserLaunch((onError) => {
    if (mode === "throw") throw new Error("SYNTHETIC_PRIVATE launcher details");
    queueMicrotask(onError);
  }, cancellation);
  oauthFailureEvidence(await running, "browser_launch_failed");
});

it.each([
  new Error("oauth_timeout: SYNTHETIC_PRIVATE authorization_code=code redirect_uri=https://example.invalid/callback access_token=token"),
  { category: "browser_launch_failed", stack: "SYNTHETIC_PRIVATE stack",
    authorization: "SYNTHETIC_PRIVATE code", redirectUrl: "https://example.invalid/SYNTHETIC_PRIVATE",
    tokens: "SYNTHETIC_PRIVATE token", cookies: "SYNTHETIC_PRIVATE cookie",
    headers: "SYNTHETIC_PRIVATE header", env: "SYNTHETIC_PRIVATE env", body: "SYNTHETIC_PRIVATE body" },
  "login_rejected", undefined,
])("maps unrecognized login failures to unknown without inspecting raw details (%#)", async (error: unknown) => {
  const auth = browserOnlyAuth(vi.fn(), new AbortController().signal);
  const failure = await runLiveOAuthLogin(() => Promise.reject(error), auth).catch((caught: unknown) => caught);
  oauthFailureEvidence(failure, "unknown");
});

it("does not infer a callback failure from prompt cancellation and clears a successful login deadline", async () => {
  vi.useFakeTimers();
  const auth = browserOnlyAuth(vi.fn(), new AbortController().signal);
  const callback = new AbortController();
  const pending = auth.prompt({ type: "manual_code", message: "offline", signal: callback.signal })
    .catch((error: unknown) => error);
  callback.abort();
  oauthFailureEvidence(await pending, "unknown");
  await runLiveOAuthLogin(() => Promise.resolve({ access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE" }), auth);
  expect(vi.getTimerCount()).toBe(0);
});

it("compiled live help is offline and never opens an authorization input path", () => {
  const output = execFileSync("bun", ["--no-env-file", "dist/live-codex.js", "--full-probe", "--stored", "--help"], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  expect(output).toContain("--full-probe --stored reuses saved login");
});
