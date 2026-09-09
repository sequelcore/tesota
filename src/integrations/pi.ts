import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Static,
  type AssistantMessage,
  type Context,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
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
