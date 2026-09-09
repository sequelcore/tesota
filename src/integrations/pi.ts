import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Static,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AuthInteraction,
  type Context,
  type FauxResponseStep,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  isIssuedOxlintResult,
  runOxlint,
  type OxlintCheck,
} from "../verification/oxlint.js";
import type {
  CompletedOxlintResult,
  OxlintResult,
} from "../verification/oxlint-result.js";

/** Synthetic scenarios only; this module is not a production Pi integration. */
export type SyntheticPiScenario = "successful_turn" | "verification_request" | "abort";

export type VerificationExecutor =
  (check: OxlintCheck, input: string) => Promise<OxlintResult>;

export interface PiSessionOptions {
  readonly check: OxlintCheck;
  readonly input: string;
  readonly scenario: SyntheticPiScenario;
  readonly requestedInput?: string;
  readonly admitVerification?: boolean;
  readonly verificationExecutor?: VerificationExecutor;
}

export type PiSessionEvent =
  | { readonly type: "session_started" }
  | { readonly type: "turn_started" }
  | { readonly type: "verification_requested"; readonly input: string }
  | { readonly type: "verification_admitted"; readonly input: string }
  | { readonly type: "verification_denied"; readonly input: string; readonly reason: string }
  | { readonly type: "verification_completed"; readonly status: OxlintResult["status"] }
  | { readonly type: "turn_completed" }
  | { readonly type: "session_completed"; readonly taskAcceptance: "not_evaluated" }
  | { readonly type: "abort_requested" }
  | { readonly type: "session_aborted"; readonly reason: "aborted" }
  | { readonly type: "session_failed"; readonly reason: string };

export interface PiSessionResult {
  readonly status: "completed" | "aborted" | "failed";
  readonly abortRequested: boolean;
  readonly terminalStopReason: AssistantMessage["stopReason"] | undefined;
  readonly taskAcceptance: "not_evaluated";
  readonly response: string;
  readonly events: readonly PiSessionEvent[];
  readonly verification?: OxlintResult;
  readonly issuedEvidence?: CompletedOxlintResult;
}

export type LiveCodexSessionStatus = "completed" | "aborted" | "failed";

export type LiveCodexEvent =
  | { readonly type: "session_started" }
  | { readonly type: "turn_started" }
  | { readonly type: "stream_event"; readonly event: AssistantMessageEvent["type"] }
  | { readonly type: "turn_completed" }
  | { readonly type: "session_completed" }
  | { readonly type: "abort_requested" }
  | { readonly type: "session_aborted" }
  | { readonly type: "session_failed" };

export interface LiveCodexTurnResult {
  readonly status: LiveCodexSessionStatus;
  readonly provider: "openai-codex";
  readonly api: "openai-codex-responses";
  readonly model: string;
  readonly authType: "oauth";
  readonly providerRequestCount: number;
  readonly streamEventCount: number;
  readonly streamEventTypes: readonly AssistantMessageEvent["type"][];
  readonly terminalStopReason: AssistantMessage["stopReason"] | undefined;
  readonly abortRequested: boolean;
  readonly taskAcceptance: "not_evaluated";
  readonly toolCallCount: number;
  readonly toolExecutionCount: number;
  readonly responseMatchesExpectedToken: boolean;
  readonly events: readonly LiveCodexEvent[];
}

export interface LiveCodexExperimentOptions {
  /** Pi's provider-owned OAuth interaction; credentials remain in Pi's memory store. */
  readonly authInteraction?: AuthInteraction;
  readonly modelId?: string;
  readonly includeAbortProbe?: boolean;
}

export interface LiveCodexExperimentResult {
  readonly turn: LiveCodexTurnResult;
  readonly abortProbe?: LiveCodexTurnResult;
}

export const LIVE_CODEX_MODEL_ID = "gpt-5.3-codex-spark";
export const LIVE_CODEX_EXPECTED_TOKEN = "TESOTA_M31A_OK";

/** Normalize Pi's observed terminal outcome without inferring from a request. */
export function normalizeLiveCodexStatus(
  terminalStopReason: AssistantMessage["stopReason"] | undefined,
  agentErrorObserved: boolean,
): LiveCodexSessionStatus {
  if (terminalStopReason === "aborted") return "aborted";
  if (terminalStopReason === undefined || terminalStopReason === "pending" ||
      terminalStopReason === "error" || agentErrorObserved) return "failed";
  return "completed";
}

interface VerificationToolDetails {
  readonly status: OxlintResult["status"];
}

const verificationParameters = Type.Object({
  input: Type.String(),
});

type VerificationArguments = Static<typeof verificationParameters>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestedVerificationInput(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value["input"] !== "string") return undefined;
  return value["input"];
}

function isCompleted(result: OxlintResult): result is CompletedOxlintResult {
  return result.status === "passed" || result.status === "check_failed";
}

function unissuedResult(): OxlintResult {
  return {
    status: "execution_failed",
    reason: "unissued_verification_result",
    process: "not_started",
  };
}

function boundedVerificationText(result: OxlintResult): string {
  if (result.status === "execution_failed") {
    return "Tesota verification execution_failed";
  }
  return `Tesota verification ${result.status}; diagnostics=${result.diagnostics.length}`;
}

function assistantText(messages: readonly AgentMessage[]): string {
  let text = "";
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
    }
  }
  return text;
}

function continuationResponse(context: Context): AssistantMessage {
  const receivedBoundedResult = context.messages.some((message) =>
    message.role === "toolResult" && message.content.some((block) =>
      block.type === "text" && block.text.startsWith("Tesota verification ")));
  return fauxAssistantMessage(receivedBoundedResult
    ? "Synthetic Pi turn continued after the bounded Tesota result."
    : "Synthetic Pi turn did not receive the bounded Tesota result.");
}

function syntheticResponse(options: PiSessionOptions, requestAbort: () => void): FauxResponseStep[] {
  if (options.scenario === "abort") {
    return [async (_context, streamOptions) => {
      const signal = streamOptions?.signal;
      if (signal === undefined) throw new Error("Synthetic abort requires Pi's signal");
      // Keep the faux response active until Pi processes the request. The faux
      // streamer, not this factory, produces the terminal aborted message.
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
        requestAbort();
      });
      return fauxAssistantMessage("Synthetic Pi turn completed.");
    }];
  }
  if (options.scenario === "successful_turn") {
    return [fauxAssistantMessage("Synthetic Pi turn completed.")];
  }
  const input = options.requestedInput ?? options.input;
  return [
    fauxAssistantMessage(fauxToolCall("tesota_verify", { input })),
    continuationResponse,
  ];
}

/** Run exactly one in-memory Pi agent turn with the Tesota verification action. */
export async function runPiSession(options: PiSessionOptions): Promise<PiSessionResult> {
  const events: PiSessionEvent[] = [];
  let verification: OxlintResult | undefined;
  let issuedEvidence: CompletedOxlintResult | undefined;
  let abortRequested = false;
  let terminalStopReason: AssistantMessage["stopReason"] | undefined;
  let status: PiSessionResult["status"] = "failed";
  const executeVerification = options.verificationExecutor ?? runOxlint;
  const faux = fauxProvider({
    api: "tesota-synthetic-api",
    provider: "tesota-synthetic-provider",
    models: [{ id: "tesota-synthetic-model", name: "Tesota synthetic model" }],
    tokensPerSecond: 1_000,
  });

  const verificationTool: AgentTool<typeof verificationParameters, VerificationToolDetails> = {
    name: "tesota_verify",
    label: "Tesota verification",
    description: "Request the one bounded Tesota-owned source verification action.",
    parameters: verificationParameters,
    execute: async (_toolCallId: string, args: VerificationArguments, signal?: AbortSignal) => {
      if (signal?.aborted) throw new Error("Tesota verification aborted");
      let result: OxlintResult;
      try {
        result = await executeVerification(options.check, args.input);
      } catch {
        result = {
          status: "execution_failed",
          reason: "verification_executor_failed",
          process: "not_started",
        };
      }
      if (isCompleted(result) && !isIssuedOxlintResult(result)) result = unissuedResult();
      verification = result;
      if (isCompleted(result)) issuedEvidence = result;
      events.push({ type: "verification_completed", status: result.status });
      return {
        content: [{ type: "text", text: boundedVerificationText(result) }],
        details: { status: result.status },
      };
    },
  };

  const agent = new Agent({
    streamFn: faux.provider.streamSimple,
    initialState: {
      systemPrompt: "You are a synthetic model. Use the supplied Tesota action once when requested.",
      model: faux.getModel(),
      thinkingLevel: "off",
      tools: [verificationTool],
    },
    toolExecution: "sequential",
    beforeToolCall: async (context) => {
      const input = requestedVerificationInput(context.args);
      if (input === undefined) {
        events.push({ type: "verification_denied", input: "<invalid>", reason: "invalid_request" });
        return { block: true, reason: "Tesota denied an invalid verification request." };
      }
      events.push({ type: "verification_requested", input });
      if (options.admitVerification === false || input !== options.input) {
        events.push({ type: "verification_denied", input, reason: "not_admitted_by_tesota" });
        return { block: true, reason: "Tesota did not admit this verification action." };
      }
      events.push({ type: "verification_admitted", input });
      return undefined;
    },
  });

  const unsubscribe = agent.subscribe(async (event) => {
    switch (event.type) {
      case "agent_start":
        events.push({ type: "session_started" });
        break;
      case "turn_start":
        events.push({ type: "turn_started" });
        break;
      case "turn_end":
        events.push({ type: "turn_completed" });
        break;
      case "agent_end":
        terminalStopReason = event.messages.findLast((message) => message.role === "assistant")?.stopReason;
        if (terminalStopReason === "aborted") {
          status = "aborted";
          events.push({ type: "session_aborted", reason: "aborted" });
        } else if (terminalStopReason === undefined || terminalStopReason === "pending" ||
                   terminalStopReason === "error" || agent.state.errorMessage !== undefined) {
          status = "failed";
          events.push({ type: "session_failed", reason: agent.state.errorMessage ?? "missing_terminal_outcome" });
        } else {
          status = "completed";
          events.push({ type: "session_completed", taskAcceptance: "not_evaluated" });
        }
        break;
      default:
        break;
    }
  });

  faux.setResponses(syntheticResponse(options, () => {
    abortRequested = true;
    events.push({ type: "abort_requested" });
    agent.abort();
  }));

  try {
    await agent.prompt("Run the bounded synthetic turn.");
    return {
      status,
      abortRequested,
      terminalStopReason,
      taskAcceptance: "not_evaluated",
      response: assistantText(agent.state.messages),
      events,
      ...(verification === undefined ? {} : { verification }),
      ...(issuedEvidence === undefined ? {} : { issuedEvidence }),
    };
  } finally {
    unsubscribe();
  }
}

function assistantResponseText(messages: readonly AgentMessage[]): string {
  let response = "";
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type === "text") response += block.text;
    }
  }
  return response;
}

async function runLiveCodexTurn(
  models: ReturnType<typeof createModels>,
  model: NonNullable<ReturnType<ReturnType<typeof createModels>["getModel"]>>,
  abortOnFirstStreamEvent: boolean,
): Promise<LiveCodexTurnResult> {
  const events: LiveCodexEvent[] = [];
  const streamEventTypes: AssistantMessageEvent["type"][] = [];
  let providerRequestCount = 0;
  let abortRequested = false;
  let terminalStopReason: AssistantMessage["stopReason"] | undefined;
  let toolCallCount = 0;
  let toolExecutionCount = 0;
  let agentErrorObserved = false;
  let abortIssued = false;

  const agent = new Agent({
    streamFn: (requestModel, context, streamOptions) => {
      providerRequestCount += 1;
      return models.streamSimple(requestModel, context, {
        ...streamOptions,
        cacheRetention: "none",
        maxRetries: 0,
        timeoutMs: 30_000,
        transport: "sse",
      });
    },
    initialState: {
      systemPrompt: "Return only the requested fixed token. Do not use tools.",
      model,
      thinkingLevel: "off",
      tools: [],
    },
  });

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case "agent_start":
        events.push({ type: "session_started" });
        break;
      case "turn_start":
        events.push({ type: "turn_started" });
        break;
      case "message_update":
        streamEventTypes.push(event.assistantMessageEvent.type);
        events.push({ type: "stream_event", event: event.assistantMessageEvent.type });
        if (abortOnFirstStreamEvent && streamEventTypes.length === 1 && !abortIssued) {
          abortIssued = true;
          abortRequested = true;
          events.push({ type: "abort_requested" });
          agent.abort();
        }
        break;
      case "tool_execution_start":
        toolExecutionCount += 1;
        break;
      case "turn_end":
        events.push({ type: "turn_completed" });
        break;
      case "agent_end":
        terminalStopReason = event.messages.findLast((message) => message.role === "assistant")?.stopReason;
        toolCallCount = event.messages.reduce((count, message) => {
          if (message.role !== "assistant") return count;
          return count + message.content.filter((block) => block.type === "toolCall").length;
        }, 0);
        agentErrorObserved = agent.state.errorMessage !== undefined;
        if (terminalStopReason === "aborted") events.push({ type: "session_aborted" });
        else if (normalizeLiveCodexStatus(terminalStopReason, agentErrorObserved) === "failed") {
          events.push({ type: "session_failed" });
        } else {
          events.push({ type: "session_completed" });
        }
        break;
      default:
        break;
    }
  });

  try {
    await agent.prompt(`Reply with exactly ${LIVE_CODEX_EXPECTED_TOKEN} and no other text.`);
  } catch {
    agentErrorObserved = true;
  } finally {
    unsubscribe();
  }

  const status = normalizeLiveCodexStatus(terminalStopReason, agentErrorObserved);
  return {
    status,
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: model.id,
    authType: "oauth",
    providerRequestCount,
    streamEventCount: streamEventTypes.length,
    streamEventTypes,
    terminalStopReason,
    abortRequested,
    taskAcceptance: "not_evaluated",
    toolCallCount,
    toolExecutionCount,
    responseMatchesExpectedToken: status === "completed" &&
      assistantResponseText(agent.state.messages).trim() === LIVE_CODEX_EXPECTED_TOKEN,
    events,
  };
}

/** Run the opt-in live Codex OAuth experiment with no Tesota-owned tools. */
export async function runLiveCodexExperiment(
  options: LiveCodexExperimentOptions,
): Promise<LiveCodexExperimentResult> {
  const models = createModels();
  const provider = openaiCodexProvider();
  models.setProvider(provider);

  const providers = models.getProviders();
  if (providers.length !== 1 || providers[0]?.id !== "openai-codex" ||
      providers[0]?.auth.apiKey !== undefined || providers[0]?.auth.oauth === undefined) {
    throw new Error("Live Codex route was not isolated to Pi OAuth");
  }

  const modelId = options.modelId ?? LIVE_CODEX_MODEL_ID;
  const model = models.getModel("openai-codex", modelId);
  if (model === undefined || model.api !== "openai-codex-responses") {
    throw new Error("Requested Codex model is not in the locked Pi catalog");
  }

  const authBeforeLogin = await models.checkAuth("openai-codex");
  if (authBeforeLogin === undefined) {
    if (options.authInteraction === undefined) {
      throw new Error("Pi Codex OAuth requires an explicit authentication interaction");
    }
    await models.login("openai-codex", "oauth", options.authInteraction);
  }
  const auth = await models.checkAuth("openai-codex");
  if (auth?.type !== "oauth") throw new Error("Pi Codex OAuth was not configured");

  const turn = await runLiveCodexTurn(models, model, false);
  if (!options.includeAbortProbe) return { turn };
  const abortProbe = await runLiveCodexTurn(models, model, true);
  return { turn, abortProbe };
}
