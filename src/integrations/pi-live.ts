import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream, createModels,
  type Api, type AssistantMessage, type AuthInteraction, type CredentialStore, type Model, type Models,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export const LIVE_CODEX_MODEL_ID = "gpt-5.3-codex-spark";
export const LIVE_CODEX_EXPECTED_TOKEN = "TESOTA_CODEX_OK";
export const LIVE_LIMITS: Readonly<{
  modelInvocationsPerProbe: number; turnMs: number; settlementMs: number; loginMs: number;
}> = Object.freeze({ modelInvocationsPerProbe: 1, turnMs: 30_000, settlementMs: 2_000, loginMs: 180_000 });

export type LiveObservation =
  | "session_started" | "turn_started" | "model_invocation_started"
  | "stream_update" | "abort_requested" | "tool_execution_started"
  | "request_budget_exceeded" | "deadline_expired" | "turn_completed"
  | "terminal_stop" | "terminal_aborted" | "terminal_other"
  | "normalized_completed" | "normalized_aborted" | "normalized_failed"
  | "settlement_unconfirmed";

export interface LiveCodexTurnResult {
  readonly status: "completed" | "aborted" | "failed" | "unsettled";
  /** Calls admitted to Pi Models.streamSimple, not independently observed HTTP requests. */
  readonly modelInvocationCount: number;
  readonly invocationAttempts: number;
  /** Pi tool_execution_start observations, including rejected/nonexistent attempts. */
  readonly toolExecutionStartCount: number;
  readonly streamUpdateCount: number;
  readonly terminalStopReason: AssistantMessage["stopReason"] | null;
  readonly terminalObserved: boolean;
  readonly abortRequested: boolean;
  readonly taskAcceptance: "not_evaluated";
  readonly responseMatchesExpectedToken: boolean;
  readonly responseDiagnostic: {
    readonly messageObserved: boolean;
    readonly textBlockCount: number;
    readonly nonTextBlockCount: number;
    readonly thinkingBlockCount: number;
    readonly textMatchesExpectedToken: boolean;
  };
  readonly requestBudgetExceeded: boolean;
  readonly deadlineExpired: boolean;
  readonly settlement: "observed" | "unconfirmed";
  readonly events: readonly LiveObservation[];
  readonly providerDiagnostic: {
    /** Validated status from Pi onResponse only; null does not imply no request. */
    readonly httpStatus: number | null;
    /** Observation stage of a failed turn, not a provider root cause. */
    readonly failureStage: "response_not_observed" | "http_rejection" | "after_response" | null;
    /** Locked Pi exposes free-text errors here, not a safe structured code. */
    readonly providerErrorCode: null;
  };
}

export interface LiveCodexExperimentResult {
  readonly turn: LiveCodexTurnResult;
  readonly abortProbe: LiveCodexTurnResult | null;
}

export type LiveOAuthFailureCategory = "oauth_timeout" | "browser_launch_failed" | "unknown";

export type LiveAuthenticationMethod = "browser" | "device_code" | "stored";
export interface LiveAuthInteraction extends AuthInteraction {
  readonly authenticationMethod: LiveAuthenticationMethod;
}

export type LiveCodexMode = "auth_only" | "full_probe";
export type LiveAuthenticationResult =
  | { readonly outcome: "succeeded"; readonly oauthFailureCategory: null }
  | { readonly outcome: "failed"; readonly oauthFailureCategory: LiveOAuthFailureCategory }
  | { readonly outcome: "unconfirmed"; readonly oauthFailureCategory: "oauth_timeout" };

export type LiveCodexRunResult = {
  readonly authentication: LiveAuthenticationResult;
  readonly authenticationMethod: LiveAuthenticationMethod;
} & (
  // inferenceAttempted is exclusively the AUTH-ONLY forbidden-inference latch.
  // Ordinary full-probe invocations are counted by modelInvocationCount.
  | { readonly mode: "auth_only"; readonly experiment: null; readonly inferenceAttempted: boolean;
      readonly disposition: "succeeded" | "failed" }
  | { readonly mode: "full_probe"; readonly experiment: LiveCodexExperimentResult | null;
      readonly inferenceAttempted: false; readonly disposition: "passed" | "failed" }
);

/** Local diagnostic only. Never attach the original exception or authorization data. */
class LiveOAuthFailure extends Error {
  readonly category: Exclude<LiveOAuthFailureCategory, "unknown">;
  constructor(category: Exclude<LiveOAuthFailureCategory, "unknown">) {
    super("Live OAuth failed");
    this.category = category;
  }
}

/** Observe launcher exceptions/error events without retaining their payloads. */
export function observeLiveBrowserLaunch(
  launch: (onError: () => void) => void, cancellation: AbortController,
): void {
  const failed = (): void => cancellation.abort(new LiveOAuthFailure("browser_launch_failed"));
  try { launch(failed); } catch { failed(); }
}

export function classifyLiveOAuthFailure(error: unknown): LiveOAuthFailureCategory {
  if (error instanceof LiveOAuthFailure) {
    if (error.category === "oauth_timeout" || error.category === "browser_launch_failed") return error.category;
  }
  return "unknown";
}

/** Protocol failure stream: the public StreamFn contract forbids throwing. */
function deniedStream(model: Model<Api>): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error", errorMessage: "Tesota live invocation denied", timestamp: Date.now(),
  };
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

/** One bounded turn. Injectable public stream boundary permits credential-free regressions. */
export async function runLiveCodexTurn(
  stream: StreamFn, model: Model<Api>, abortOnUpdate: boolean,
): Promise<LiveCodexTurnResult> {
  const events: LiveObservation[] = [];
  let modelInvocationCount = 0;
  let invocationAttempts = 0;
  let toolExecutionStartCount = 0;
  let streamUpdateCount = 0;
  let terminalStopReason: AssistantMessage["stopReason"] | null = null;
  let terminalObserved = false;
  let abortRequested = false;
  let deadlineExpired = false;
  let requestBudgetExceeded = false;
  let closed = false;
  let agentErrorObserved = false;
  let responseMatchesExpectedToken = false;
  let responseDiagnostic: LiveCodexTurnResult["responseDiagnostic"] = {
    messageObserved: false, textBlockCount: 0, nonTextBlockCount: 0, thinkingBlockCount: 0, textMatchesExpectedToken: false,
  };
  let httpStatus: number | null = null;
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((resolve) => { resolveFinished = resolve; });
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;

  const agent = new Agent({
    streamFn: (requestModel, context, options) => {
      invocationAttempts += 1;
      if (modelInvocationCount >= LIVE_LIMITS.modelInvocationsPerProbe) {
        requestBudgetExceeded = true;
        if (!closed) events.push("request_budget_exceeded");
        return deniedStream(requestModel);
      }
      if (closed || deadlineExpired) return deniedStream(requestModel);
      modelInvocationCount += 1;
      events.push("model_invocation_started");
      return stream(requestModel, context, { ...options, cacheRetention: "none",
        maxRetries: 0, timeoutMs: LIVE_LIMITS.turnMs, transport: "sse", maxTokens: 64,
        onResponse: ({ status }) => {
          // Never retain headers or the response object. Ignore late observations.
          if (!closed && Number.isInteger(status) && status >= 100 && status <= 599) httpStatus = status;
        } });
    },
    initialState: { systemPrompt: "Return only the requested fixed token. Do not use tools.",
      model, thinkingLevel: "off", tools: [] },
  });
  function requestAbort(): void {
    if (abortRequested) return;
    abortRequested = true;
    events.push("abort_requested");
    // A request starts a bounded observation window; it is never settlement.
    settlementTimer = setTimeout(() => resolveFinished(), LIVE_LIMITS.settlementMs);
    agent.abort();
  }
  const unsubscribe = agent.subscribe((event) => {
    if (closed) return;
    switch (event.type) {
      case "agent_start": events.push("session_started"); break;
      case "turn_start": events.push("turn_started"); break;
      case "message_update":
        // Pi forwards start/done/error too. Only actual content deltas prove streaming.
        if (event.assistantMessageEvent.type === "text_delta" ||
            event.assistantMessageEvent.type === "thinking_delta" ||
            event.assistantMessageEvent.type === "toolcall_delta") {
          streamUpdateCount += 1;
          // Retain the first update's order, not an unbounded event transcript.
          if (streamUpdateCount === 1) events.push("stream_update");
          if (abortOnUpdate) requestAbort();
        }
        break;
      case "tool_execution_start":
        toolExecutionStartCount += 1;
        events.push("tool_execution_started");
        break;
      case "turn_end": events.push("turn_completed"); break;
      case "agent_end": {
        terminalObserved = true;
        const message = event.messages.findLast((item) => item.role === "assistant");
        terminalStopReason = message?.stopReason ?? null;
        agentErrorObserved = agent.state.errorMessage !== undefined;
        const content = message?.content;
        const textBlocks = content?.filter((block) => block.type === "text") ?? [];
        responseDiagnostic = {
          messageObserved: message !== undefined,
          textBlockCount: textBlocks.length,
          nonTextBlockCount: (content?.length ?? 0) - textBlocks.length,
          thinkingBlockCount: content?.filter((block) => block.type === "thinking").length ?? 0,
          textMatchesExpectedToken: textBlocks.map((block) => block.text).join("").trim() === LIVE_CODEX_EXPECTED_TOKEN,
        };
        // Pi represents provider reasoning separately from answer text, even without a summary.
        // Only text and thinking are permitted; tool calls and future block types fail closed.
        responseMatchesExpectedToken = responseDiagnostic.nonTextBlockCount === responseDiagnostic.thinkingBlockCount &&
          responseDiagnostic.textMatchesExpectedToken;
        events.push(terminalStopReason === "stop" ? "terminal_stop" :
          terminalStopReason === "aborted" ? "terminal_aborted" : "terminal_other");
        resolveFinished();
        break;
      }
      default: break;
    }
  });
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    events.push("deadline_expired");
    requestAbort();
  }, LIVE_LIMITS.turnMs);
  // Do not await a possibly never-settling body/prompt. Observe terminal events instead.
  void agent.prompt(`Reply with exactly ${LIVE_CODEX_EXPECTED_TOKEN} and no other text.`)
    .catch(() => { agentErrorObserved = true; resolveFinished(); });
  await finished;
  closed = true;
  clearTimeout(deadline);
  clearTimeout(settlementTimer);
  unsubscribe();
  const status = !terminalObserved ? "unsettled" : requestBudgetExceeded ? "failed" :
    terminalStopReason === "aborted" ? "aborted" :
    terminalStopReason === "stop" && !agentErrorObserved ? "completed" : "failed";
  events.push(status === "unsettled" ? "settlement_unconfirmed" :
    status === "aborted" ? "normalized_aborted" :
    status === "completed" ? "normalized_completed" : "normalized_failed");
  return { status, modelInvocationCount, invocationAttempts, toolExecutionStartCount,
    streamUpdateCount, terminalStopReason, terminalObserved, abortRequested,
    taskAcceptance: "not_evaluated", responseMatchesExpectedToken, responseDiagnostic, requestBudgetExceeded,
    deadlineExpired, settlement: terminalObserved ? "observed" : "unconfirmed", events,
    providerDiagnostic: {
      httpStatus,
      failureStage: status !== "failed" ? null : httpStatus === null ? "response_not_observed" :
        httpStatus >= 300 ? "http_rejection" : "after_response",
      providerErrorCode: null,
    } };
}

export function liveProbePasses(probe: LiveCodexTurnResult, abort: boolean): boolean {
  const events = probe.events;
  const ordered = (names: readonly LiveObservation[]): boolean => {
    let previous = -1;
    return names.every((name) => {
      const index = events.indexOf(name);
      const valid = index > previous;
      previous = index;
      return valid;
    });
  };
  const common = probe.modelInvocationCount === 1 && probe.invocationAttempts === 1 &&
    probe.toolExecutionStartCount === 0 && !events.includes("tool_execution_started") &&
    !probe.requestBudgetExceeded && !events.includes("request_budget_exceeded") &&
    !probe.deadlineExpired && !events.includes("deadline_expired") &&
    probe.terminalObserved && probe.settlement === "observed" && probe.taskAcceptance === "not_evaluated" &&
    events.filter((event) => event === "model_invocation_started").length === 1;
  if (!common) return false;
  return abort ? probe.status === "aborted" && probe.terminalStopReason === "aborted" &&
    probe.abortRequested && probe.streamUpdateCount > 0 && ordered([
      "model_invocation_started", "stream_update", "abort_requested", "terminal_aborted", "normalized_aborted",
    ]) : probe.status === "completed" && probe.terminalStopReason === "stop" &&
    !probe.abortRequested && !events.includes("abort_requested") && probe.responseMatchesExpectedToken &&
    ordered(["model_invocation_started", "terminal_stop", "normalized_completed"]);
}

/** AUTH-ONLY has no probe/Agent path. A denied attempt remains a failure even if caught. */
function codexModels(credentials?: CredentialStore, deny?: () => never): Models {
  const models = createModels(credentials === undefined ? {} : { credentials });
  const provider = openaiCodexProvider();
  if (deny !== undefined) {
    for (const method of ["stream", "streamSimple", "complete", "completeSimple",
      "streamDeferred", "fetchDeferred", "cancelDeferred"] as const satisfies readonly (keyof Models)[]) {
      Object.defineProperty(models, method, { value: deny, writable: false, configurable: false });
    }
    for (const method of ["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const) {
      Object.defineProperty(provider, method, { value: deny, writable: false, configurable: false });
    }
  }
  models.setProvider(provider);
  if (models.getProviders().length !== 1 || provider.id !== "openai-codex" ||
      provider.auth.apiKey !== undefined || provider.auth.oauth === undefined) {
    throw new Error("Live Codex route is not isolated to OAuth");
  }
  return models;
}

async function resolveStoredCodex(models: Models, credentials: CredentialStore, interaction: AuthInteraction): Promise<void> {
  if ((await credentials.read("openai-codex"))?.type !== "oauth") throw new Error("Run tesota auth login first");
  await runLiveOAuthLogin(async (auth) => {
    if (await models.getAuth("openai-codex", auth.signal === undefined ? {} : { signal: auth.signal }) === undefined) {
      throw new Error("Saved Codex login unavailable");
    }
  }, interaction);
}

/** Same isolated route and bounded credential resolution as the turn probes. */
export async function storedCodexModels(credentials: CredentialStore, signal: AbortSignal): Promise<Models> {
  const models = codexModels(credentials);
  await resolveStoredCodex(models, credentials, {
    signal,
    prompt: async () => { throw new Error("Stored login cannot prompt"); },
    notify: () => { throw new Error("Stored login cannot notify"); },
  });
  return models;
}

export async function runLiveCodex(
  mode: LiveCodexMode, authInteraction: LiveAuthInteraction,
  credentials?: CredentialStore,
): Promise<LiveCodexRunResult> {
  let authentication: LiveAuthenticationResult = { outcome: "failed", oauthFailureCategory: "unknown" };
  let experiment: LiveCodexExperimentResult | null = null;
  let inferenceAttempted = false;
  const authOnlyResult = (): LiveCodexRunResult => ({ mode: "auth_only", authenticationMethod: authInteraction.authenticationMethod, authentication,
    experiment: null, inferenceAttempted,
    disposition: authentication.outcome === "succeeded" && !inferenceAttempted ? "succeeded" : "failed" });
  try {
    const models = codexModels(credentials, mode === "auth_only" ? (): never => {
        inferenceAttempted = true;
        throw new Error("Tesota AUTH-ONLY inference denied");
      } : undefined);
    if (authInteraction.authenticationMethod === "stored") {
      if (mode !== "full_probe" || credentials === undefined) {
        throw new Error("Run tesota auth login first");
      }
      await resolveStoredCodex(models, credentials, authInteraction);
    } else {
      await runLiveOAuthLogin((interaction) => models.login("openai-codex", "oauth", interaction), authInteraction);
    }
    authentication = { outcome: "succeeded", oauthFailureCategory: null };
    if (mode === "auth_only") return authOnlyResult();

    experiment = await runLiveCodexExperiment(models);
  } catch (error) {
    if (authentication.outcome !== "succeeded") {
      const category = classifyLiveOAuthFailure(error);
      authentication = category === "oauth_timeout" ? { outcome: "unconfirmed", oauthFailureCategory: category } :
        { outcome: "failed", oauthFailureCategory: category };
    }
  }
  if (mode === "auth_only") return authOnlyResult();
  return { mode, authenticationMethod: authInteraction.authenticationMethod, authentication, experiment, inferenceAttempted: false,
    disposition: experiment !== null && liveProbePasses(experiment.turn, false) && experiment.abortProbe !== null &&
      liveProbePasses(experiment.abortProbe, true) ? "passed" : "failed" };
}

/** No retries: a failed normal probe stops the experiment before its abort probe. */
async function runLiveCodexExperiment(models: Models): Promise<LiveCodexExperimentResult> {
  const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
  if (model?.api !== "openai-codex-responses") throw new Error("Locked model unavailable");
  const stream: StreamFn = (requestModel, context, options) => models.streamSimple(requestModel, context, options);
  const turn = await runLiveCodexTurn(stream, model, false);
  if (!liveProbePasses(turn, false)) return { turn, abortProbe: null };
  const abortProbe = await runLiveCodexTurn(stream, model, true);
  return { turn, abortProbe };
}

/** The injected public login boundary is exercised offline; credentials are ignored. */
export async function runLiveOAuthLogin(
  login: (interaction: AuthInteraction) => Promise<unknown>, authInteraction: AuthInteraction,
): Promise<void> {
  const cancellation = new AbortController();
  const signal = authInteraction.signal === undefined ? cancellation.signal :
    AbortSignal.any([authInteraction.signal, cancellation.signal]);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "succeeded" | "failed", error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (outcome === "succeeded") resolve();
      else reject(error);
    };
    const aborted = (): void => finish("failed", signal.reason);
    // First authoritative local observation wins, before downstream promise cleanup.
    // Abort listeners observe browser failure synchronously; the deadline observes
    // timeout before requesting cancellation. Late failures cannot replace either.
    const timer = setTimeout(() => {
      const failure = new LiveOAuthFailure("oauth_timeout");
      finish("failed", failure);
      cancellation.abort(failure);
    }, LIVE_LIMITS.loginMs);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    try {
      void login({
        signal,
        prompt: (prompt) => {
          if (settled || signal.aborted) return Promise.reject(new Error("Login interaction closed"));
          return authInteraction.prompt(prompt);
        },
        notify: (event) => {
          if (settled || signal.aborted) throw new Error("Login interaction closed");
          authInteraction.notify(event);
        },
      }).then(
        () => finish("succeeded"), (error: unknown) => finish("failed", error),
      );
    } catch (error) { finish("failed", error); }
  });
}

/** Pi races manual_code with its callback server. Never read terminal authorization input. */
export function browserOnlyAuth(openBrowser: (url: string) => void, signal: AbortSignal): LiveAuthInteraction {
  return {
    authenticationMethod: "browser", signal,
    prompt: async (prompt) => {
      if (prompt.type === "select" && prompt.options.some((option) => option.id === "browser")) return "browser";
      if (prompt.type !== "manual_code" || prompt.signal === undefined) {
        throw new Error("Manual authorization input is disabled; browser callback required");
      }
      return new Promise<string>((_resolve, reject) => {
        const cancel = (): void => {
          signal.removeEventListener("abort", cancel);
          prompt.signal?.removeEventListener("abort", cancel);
          reject(new Error("Browser callback input closed"));
        };
        if (signal.aborted || prompt.signal?.aborted) cancel();
        else {
          signal.addEventListener("abort", cancel, { once: true });
          prompt.signal?.addEventListener("abort", cancel, { once: true });
        }
      });
    },
    notify: (event) => {
      // Do not print provider-owned free text or authorization URLs.
      if (event.type === "auth_url") openBrowser(event.url);
      else if (event.type === "device_code") throw new Error("Device login is disabled");
    },
  };
}

/** The only presentation data admitted from Pi's device notification. */
export interface DeviceCodePresentation {
  readonly verificationUri: string;
  readonly userCode: string;
}

/** Requires all standard streams to be interactive; never use console/log output for codes. */
export function deviceCodeTerminalRenderer(
  terminal: {
    readonly stdin: { readonly isTTY?: boolean };
    readonly stdout: { readonly isTTY?: boolean };
    readonly stderr: { readonly isTTY?: boolean; write(text: string): unknown };
  } = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
): (presentation: DeviceCodePresentation) => void {
  const requireTerminal = (): void => {
    if (terminal.stdin.isTTY !== true || terminal.stdout.isTTY !== true || terminal.stderr.isTTY !== true) {
      throw new Error("Device-code login requires an interactive, unrecorded terminal; captured execution is disabled.");
    }
  };
  requireTerminal();
  return ({ verificationUri, userCode }) => {
    requireTerminal();
    terminal.stderr.write(`Open ${verificationUri} manually. Enter this temporary code only on that website: ${userCode}\n`);
  };
}

/** Locked public Pi selection and notification only. No browser/manual input or retry. */
export function deviceCodeAuth(
  render: (presentation: DeviceCodePresentation) => void, signal: AbortSignal,
): LiveAuthInteraction {
  const cancellation = new AbortController();
  const combined = AbortSignal.any([signal, cancellation.signal]);
  let selected = false;
  let presented = false;
  const rejectInteraction = (): never => {
    const error = new Error("Device-code interaction unavailable or unexpected");
    cancellation.abort(error);
    throw error;
  };
  return {
    authenticationMethod: "device_code", signal: combined,
    prompt: async (prompt) => {
      if (combined.aborted || selected || prompt.signal?.aborted || prompt.type !== "select" ||
          !prompt.options.some((option) => option.id === "device_code")) return rejectInteraction();
      selected = true;
      return "device_code";
    },
    notify: (event) => {
      if (combined.aborted) return rejectInteraction();
      if (event.type === "info" || event.type === "progress") return;
      if (event.type !== "device_code" || !selected || presented ||
          event.verificationUri !== "https://auth.openai.com/codex/device" ||
          typeof event.userCode !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(event.userCode)) return rejectInteraction();
      presented = true;
      // Explicit two-field projection. Never forward, serialize or spread the notification.
      try { render({ verificationUri: event.verificationUri, userCode: event.userCode }); }
      catch { rejectInteraction(); }
    },
  };
}
