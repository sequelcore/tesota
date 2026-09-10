import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  Type,
  type Static,
  type AssistantMessage,
  type Context,
  type Api,
  type Model,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  createAssistantMessageEventStream,
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
import type { VerificationCandidate } from "../verification/candidate.js";

/** Offline scenarios for the bounded verification adapter. */
export type SyntheticPiScenario = "successful_turn" | "verification_request" | "abort";

export type VerificationExecutor =
  (check: OxlintCheck, input: string) => Promise<OxlintResult>;

interface VerificationSessionOptions {
  readonly check: OxlintCheck;
  readonly input: string;
  readonly requestedInput?: string;
  readonly admitVerification?: boolean;
  readonly verificationExecutor?: VerificationExecutor;
}

export type PiSessionOptions = VerificationSessionOptions & (
  | { readonly scenario: SyntheticPiScenario }
  | { readonly scenario: "live_verification"; readonly stream: StreamFn; readonly model: Model<Api> }
  | { readonly scenario: "candidate_correction"; readonly stream: StreamFn; readonly model: Model<Api>; readonly candidate: VerificationCandidate }
);

export const PI_VERIFICATION_LIMITS: Readonly<{ modelInvocations: number; verificationInvocations: number; sessionMs: number; settlementMs: number }> =
  Object.freeze({ modelInvocations: 2, verificationInvocations: 1, sessionMs: 60_000, settlementMs: 2_000 });

export const PI_CANDIDATE_LIMITS: typeof PI_VERIFICATION_LIMITS =
  Object.freeze({ modelInvocations: 4, verificationInvocations: 2, sessionMs: 90_000, settlementMs: 2_000 });

export type PiSessionEvent =
  | { readonly type: "session_started" }
  | { readonly type: "turn_started" }
  | { readonly type: "verification_requested"; readonly input: string }
  | { readonly type: "verification_admitted"; readonly input: string }
  | { readonly type: "verification_denied"; readonly input: string; readonly reason: string }
  | { readonly type: "verification_completed"; readonly status: OxlintResult["status"] }
  | { readonly type: "candidate_edited" }
  | { readonly type: "candidate_edit_denied" }
  | { readonly type: "turn_completed" }
  | { readonly type: "session_completed"; readonly taskAcceptance: "not_evaluated" }
  | { readonly type: "abort_requested" }
  | { readonly type: "session_aborted"; readonly reason: "aborted" }
  | { readonly type: "session_failed"; readonly reason: string };

export interface PiSessionResult {
  readonly status: "completed" | "aborted" | "failed" | "unsettled";
  readonly modelInvocationCount: number;
  readonly toolExecutionStartCount: number;
  readonly verificationInvocationCount: number;
  readonly resultSuppliedToContinuation: boolean;
  readonly verificationResultsSupplied: number;
  readonly budgetExceeded: boolean;
  readonly deadlineExpired: boolean;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestedVerificationInput(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1 || typeof value["input"] !== "string") return undefined;
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

function deniedPiStream(model: Model<Api>): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  const message = { ...fauxAssistantMessage(""), api: model.api, provider: model.provider,
    model: model.id, stopReason: "error" as const, errorMessage: "Tesota invocation denied" };
  stream.push({ type: "error", reason: "error", error: message });
  stream.end(message);
  return stream;
}

function assistantText(messages: readonly AgentMessage[]): string {
  let text = "";
  const message = messages.findLast((item) => item.role === "assistant");
  for (const block of message?.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type !== "thinking") return "";
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

/** One bounded Pi session, with at most one verification and one continuation. */
export async function runPiSession(options: PiSessionOptions): Promise<PiSessionResult> {
  // Snapshot trusted admission configuration before asynchronous provider work.
  options = { ...options, check: { ...options.check } };
  const candidate = options.scenario === "candidate_correction" ? options.candidate : undefined;
  const limits = candidate === undefined ? PI_VERIFICATION_LIMITS : PI_CANDIDATE_LIMITS;
  const events: PiSessionEvent[] = [];
  let verification: OxlintResult | undefined;
  let issuedEvidence: CompletedOxlintResult | undefined;
  let abortRequested = false;
  let terminalStopReason: AssistantMessage["stopReason"] | undefined;
  let status: PiSessionResult["status"] = "failed";
  let modelInvocationCount = 0;
  let toolExecutionStartCount = 0;
  let verificationInvocationCount = 0;
  let resultSuppliedToContinuation = false;
  const suppliedVerifications = new Set<OxlintResult>();
  let budgetExceeded = false;
  let deadlineExpired = false;
  let closed = false;
  const executeVerification = candidate === undefined ? options.verificationExecutor ?? runOxlint : () => candidate.verify();
  const faux = "stream" in options ? undefined : fauxProvider({
    api: "tesota-synthetic-api",
    provider: "tesota-synthetic-provider",
    models: [{ id: "tesota-synthetic-model", name: "Tesota synthetic model" }],
    tokensPerSecond: 1_000,
  });

  const model = "model" in options ? options.model : faux?.getModel();
  if (model === undefined) throw new Error("Pi model unavailable");
  const verificationParameters = Type.Object({ input: Type.Literal(options.input) }, { additionalProperties: false });
  type VerificationArguments = Static<typeof verificationParameters>;
  const verificationTool: AgentTool<typeof verificationParameters, VerificationToolDetails> = {
    name: "tesota_verify",
    label: "Tesota verification",
    description: "Request the one bounded Tesota-owned source verification action.",
    parameters: verificationParameters,
    execute: async (_toolCallId: string, args: VerificationArguments, signal?: AbortSignal) => {
      // Enforce at the effect boundary as well as Pi's pre-call hook.
      if (closed || deadlineExpired || signal?.aborted || options.admitVerification === false || requestedVerificationInput(args) !== options.input ||
          verificationInvocationCount >= limits.verificationInvocations) throw new Error("Tesota verification denied");
      verificationInvocationCount += 1;
      let result: OxlintResult;
      try {
        result = await executeVerification(options.check, options.input);
      } catch {
        result = {
          status: "execution_failed",
          reason: "verification_executor_failed",
          process: "not_started",
        };
      }
      if (isCompleted(result) && !isIssuedOxlintResult(result)) result = unissuedResult();
      if (closed) throw new Error("Tesota verification closed");
      verification = result;
      if (isCompleted(result)) issuedEvidence = result;
      events.push({ type: "verification_completed", status: result.status });
      return {
        content: [{ type: "text", text: boundedVerificationText(result) }],
        details: { status: result.status },
      };
    },
  };

  const editParameters = Type.Object({ expectedSha256: Type.String(), content: Type.String() }, { additionalProperties: false });
  const editTool: AgentTool<typeof editParameters> = {
    name: "tesota_edit_candidate", label: "Edit candidate", description: "Replace only candidate.ts after a failed check, using its expected SHA-256. At most one edit.",
    parameters: editParameters,
    execute: async (_id, args, signal) => {
      try {
        if (candidate === undefined || closed || deadlineExpired || signal?.aborted || !isRecord(args) ||
            Object.keys(args).length !== 2 || typeof args.expectedSha256 !== "string" || typeof args.content !== "string") {
          throw new Error("Candidate edit denied");
        }
        await candidate.edit(args.expectedSha256, args.content);
        if (closed) throw new Error("Candidate closed");
        events.push({ type: "candidate_edited" });
        return { content: [{ type: "text", text: "Candidate updated; verification required." }], details: {} };
      } catch {
        if (!closed) events.push({ type: "candidate_edit_denied" });
        throw new Error("Candidate edit denied");
      }
    },
  };

  const agent = new Agent({
    streamFn: (model, context, streamOptions) => {
      if (closed || deadlineExpired || modelInvocationCount >= limits.modelInvocations) {
        budgetExceeded = true;
        return deniedPiStream(model);
      }
      modelInvocationCount += 1;
      const suppliedResult = verification;
      if (suppliedResult !== undefined && context.messages.some((message) => message.role === "toolResult" &&
          message.toolName === "tesota_verify" && message.content.some((block) =>
            block.type === "text" && block.text === boundedVerificationText(suppliedResult)))) {
        resultSuppliedToContinuation = true;
        suppliedVerifications.add(suppliedResult);
      }
      const stream = "stream" in options ? options.stream : faux?.provider.streamSimple;
      if (stream === undefined) return deniedPiStream(model);
      return stream(model, context, { ...streamOptions, maxRetries: 0, transport: "sse", cacheRetention: "none", timeoutMs: limits.sessionMs });
    },
    initialState: {
      systemPrompt: candidate === undefined ? "Use tesota_verify exactly once for the requested input. After its result, reply with only TESOTA_VERIFICATION_OK. Do not call other tools." :
        "First verify candidate.ts. After the failed check, remove the debugger statement while preserving the exported value, using tesota_edit_candidate once. Verify candidate.ts again, then reply only TESOTA_CANDIDATE_OK. Use one tool per model response.",
      model,
      thinkingLevel: "off",
      tools: candidate === undefined ? [verificationTool] : [verificationTool, editTool],
    },
    toolExecution: "sequential",
    beforeToolCall: async (context) => {
      if (candidate !== undefined && context.toolCall.name === "tesota_edit_candidate") return undefined;
      const input = requestedVerificationInput(context.args);
      if (input === undefined) {
        events.push({ type: "verification_denied", input: "<invalid>", reason: "invalid_request" });
        return { block: true, reason: "Tesota denied an invalid verification request." };
      }
      events.push({ type: "verification_requested", input });
      if (closed || deadlineExpired || context.toolCall.name !== "tesota_verify" ||
          options.admitVerification === false || input !== options.input ||
          verificationInvocationCount >= limits.verificationInvocations) {
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
      case "tool_execution_start":
        toolExecutionStartCount += 1;
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

  faux?.setResponses(syntheticResponse(options, () => {
    abortRequested = true;
    events.push({ type: "abort_requested" });
    agent.abort();
  }));

  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let settlementTimer: ReturnType<typeof setTimeout> | undefined;
  const outcome = (): PiSessionResult["status"] => status;
  const deadline = setTimeout(() => {
    deadlineExpired = true;
    abortRequested = true;
    events.push({ type: "abort_requested" });
    agent.abort();
    candidate?.close();
    settlementTimer = setTimeout(() => { status = "unsettled"; settle(); }, limits.settlementMs);
  }, limits.sessionMs);
  try {
    void agent.prompt(candidate !== undefined ?
      `Correct candidate.ts. For both verification calls use exactly {"input":"candidate.ts"}. Initial SHA-256: ${candidate.hash}\nInitial content:\n${candidate.source}` : options.scenario === "live_verification" ?
      `Verify exactly this input with tesota_verify: ${JSON.stringify(options.input)}` : "Run the bounded synthetic turn.")
      .then(settle, () => { status = "failed"; settle(); });
    await settled;
    closed = true;
    candidate?.close();
    return {
      status: budgetExceeded || deadlineExpired && outcome() !== "unsettled" ? "failed" : outcome(),
      modelInvocationCount, toolExecutionStartCount, verificationInvocationCount, resultSuppliedToContinuation, budgetExceeded, deadlineExpired,
      verificationResultsSupplied: suppliedVerifications.size,
      abortRequested,
      terminalStopReason,
      taskAcceptance: "not_evaluated",
      response: assistantText(agent.state.messages),
      events: [...events],
      ...(verification === undefined ? {} : { verification }),
      ...(issuedEvidence === undefined ? {} : { issuedEvidence }),
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(settlementTimer);
    unsubscribe();
  }
}
