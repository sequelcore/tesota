import { homedir } from "node:os";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { conversationInputSchema, retainedConversationRequest, type AnswerTurn, type ClarificationTurn,
  type ConversationInput } from "./conversation-turn-contract.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { runPiDiscovery, type DiscoveryOutcome, type PiDiscoveryResult } from "./integrations/pi-discovery.js";
import { PiDiscoverySession, type DiscoveryToolFailure, type PiDiscoverySessionResult
} from "./integrations/pi-discovery-session.js";
import type { PiTaskSessionHost } from "./integrations/pi-task.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { openRepositoryDiscovery } from "./repository-discovery.js";
import { supportedProposalKind } from "./proposal-admission.js";
import { withProposalChecks } from "./task-proposal-contract.js";
import { runRepositoryGit } from "./repository-git.js";
import { formatTaskProposal, retainTaskProposal, type ProposedTask } from "./task-proposal.js";

export type CompletedConversationTurn =
  | { readonly kind: "answer"; readonly answer: AnswerTurn; readonly baseline: string }
  | { readonly kind: "clarification"; readonly clarification: ClarificationTurn; readonly baseline: string }
  | { readonly kind: "task_proposal"; readonly proposedTask: ProposedTask };

class ConversationBaselineChangedError extends Error {
  constructor() { super("Clarification baseline changed"); }
}

class ConversationDiscoveryFailed extends Error {
  readonly status: Exclude<PiDiscoveryResult["status"], "completed">;
  constructor(status: Exclude<PiDiscoveryResult["status"], "completed">) {
    super("Repository discovery did not complete");
    this.status = status;
  }
}

function signalAborted(signal?: AbortSignal): boolean { return signal?.aborted === true; }

function cancelledDiscoveryResult(error: unknown, cancellation: AbortSignal,
  writeError: (text: string) => void): ConversationCommandResult | null {
  if (error instanceof ConversationDiscoveryFailed) {
    if (error.status === "unsettled") {
      writeError("Repository discovery settlement is unconfirmed; no authority was created.\n");
      return { status: "unsettled", exitCode: 1, reason: "discovery_unconfirmed" };
    }
    if (error.status === "aborted") return { status: "cancelled", exitCode: 130, settlement: "observed" };
  }
  return cancellation.aborted ? { status: "cancelled", exitCode: 130, settlement: "observed" } : null;
}

export async function discoverConversationTurn(options: {
  readonly sourceDirectory: string;
  readonly proposalsRoot: string;
  readonly input: ConversationInput;
  readonly allowedOutcome: DiscoveryOutcome;
  readonly model: Model<Api>;
  readonly stream: StreamFn;
  readonly signal: AbortSignal;
}): Promise<CompletedConversationTurn> {
  const input = conversationInputSchema.parse(options.input);
  const discovery = await openRepositoryDiscovery(options.sourceDirectory);
  const description = discovery.describe();
  let result: PiDiscoveryResult;
  try {
    if (input.clarification !== undefined && input.clarification.baseline !== description.baseline) {
      throw new ConversationBaselineChangedError();
    }
    const outcome = input.clarification === undefined ? options.allowedOutcome : "continued_conversation";
    result = await runPiDiscovery(discovery, input, outcome, options.model, options.stream, options.signal);
  } finally {
    discovery.close();
  }
  if (result.status !== "completed" || result.outcome === null) {
    throw new ConversationDiscoveryFailed(result.status === "completed" ? "failed" : result.status);
  }
  if (result.outcome.kind === "answer") {
    return { kind: "answer", answer: result.outcome, baseline: description.baseline };
  }
  if (result.outcome.kind === "clarification") {
    return { kind: "clarification", clarification: result.outcome, baseline: description.baseline };
  }
  const request = input.clarification === undefined ? input.request : retainedConversationRequest(input);
  return { kind: "task_proposal", proposedTask: await retainTaskProposal({ proposalsRoot: options.proposalsRoot,
    request, description, result: { ...result, outcome: result.outcome }, model: options.model,
    supportedScope: supportedProposalKind(withProposalChecks(result.outcome.proposal)) !== null }) };
}

export function formatConversationTurn(turn: CompletedConversationTurn): string {
  if (turn.kind === "task_proposal") return formatTaskProposal(turn.proposedTask);
  if (turn.kind === "clarification") {
    return `Tesota needs clarification\nQuestion: ${turn.clarification.question}\n` +
      `Why: ${turn.clarification.reason}\nBaseline: ${turn.baseline}\nAuthority: none; nothing changed.\n`;
  }
  const uncertainty = turn.answer.uncertainties.length === 0 ? "" :
    `Uncertainty:\n${turn.answer.uncertainties.map((item) => `- ${item}`).join("\n")}\n`;
  return `${turn.answer.message}\nEvidence: ${turn.answer.evidenceFiles.join(", ")}\n${uncertainty}` +
    `Baseline: ${turn.baseline}\nAuthority: none; nothing changed.\n`;
}

async function liveSource(): Promise<string> {
  return realpath(runRepositoryGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
}

export type ConversationCommandResult =
  | Readonly<{ status: "completed"; exitCode: number; turn: CompletedConversationTurn }>
  | Readonly<{ status: "unavailable"; exitCode: number;
      reason: "baseline_changed" | "context_limit" | "limits_exhausted" | "invalid_result" | "tool_failed" | "timeout" | "unavailable";
      toolFailure?: DiscoveryToolFailure | null }>
  | Readonly<{ status: "cancelled"; exitCode: 130; settlement: "observed" }>
  | Readonly<{ status: "unsettled"; exitCode: 1; reason: "discovery_unconfirmed" }>;

export interface RepositoryConversationForShell {
  discover(input: ConversationInput, signal: AbortSignal): Promise<ConversationCommandResult>;
  taskHost(): PiTaskSessionHost;
  dispose(): void;
}

function sessionFailure(result: PiDiscoverySessionResult): ConversationCommandResult | null {
  if (result.status === "completed") return null;
  if (result.status === "invalid_result" || result.status === "tool_failed") {
    return { status: "unavailable", exitCode: 1, reason: result.status,
      ...(result.status === "tool_failed" ? { toolFailure: result.toolFailure } : {}) };
  }
  if (result.status === "aborted") return { status: "cancelled", exitCode: 130, settlement: "observed" };
  if (result.status === "timed_out") return { status: "unavailable", exitCode: 1, reason: "timeout" };
  if (result.status === "unsettled") return { status: "unsettled", exitCode: 1, reason: "discovery_unconfirmed" };
  if (result.status === "context_limit") return { status: "unavailable", exitCode: 1, reason: "context_limit" };
  if (result.status === "limit_exhausted") return { status: "unavailable", exitCode: 1, reason: "limits_exhausted" };
  return { status: "unavailable", exitCode: 1, reason: "unavailable" };
}

/** Continuous read-only shell conversation; Pi owns transcript mechanics while each reader remains turn-scoped. */
export async function createRepositoryConversationForShell(options: {
  readonly sourceDirectory: string;
  readonly proposalsRoot: string;
  readonly modelRuntime: ModelRuntime;
  readonly model: Model<Api>;
}): Promise<RepositoryConversationForShell> {
  const session = await PiDiscoverySession.create({ cwd: options.sourceDirectory,
    modelRuntime: options.modelRuntime, model: options.model });
  let identity: string | undefined;
  let disposed = false;
  return {
    taskHost: () => session.taskHost(),
    async discover(rawInput, signal) {
      if (disposed) throw new Error("Repository conversation disposed");
      if (signal.aborted) return { status: "cancelled", exitCode: 130, settlement: "observed" };
      const input = conversationInputSchema.parse(rawInput);
      const discovery = await openRepositoryDiscovery(options.sourceDirectory);
      const description = discovery.describe();
      const currentIdentity = JSON.stringify({ baseline: description.baseline, dirtyPaths: description.dirtyPaths });
      if (input.clarification !== undefined && input.clarification.baseline !== description.baseline ||
          identity !== undefined && identity !== currentIdentity) {
        discovery.close();
        return { status: "unavailable", exitCode: 1, reason: "baseline_changed" };
      }
      identity = currentIdentity;
      const allowedOutcome = input.clarification === undefined ? "conversation" : "continued_conversation";
      const result = await session.run(discovery, input, allowedOutcome, signal);
      const failed = sessionFailure(result);
      if (failed !== null) return failed;
      if (result.outcome === null) return { status: "unavailable", exitCode: 1, reason: "unavailable" };
      let turn: CompletedConversationTurn;
      if (result.outcome.kind === "answer") {
        turn = { kind: "answer", answer: result.outcome, baseline: description.baseline };
      } else if (result.outcome.kind === "clarification") {
        turn = { kind: "clarification", clarification: result.outcome, baseline: description.baseline };
      } else {
        const request = input.clarification === undefined ? input.request : retainedConversationRequest(input);
        turn = { kind: "task_proposal", proposedTask: await retainTaskProposal({ proposalsRoot: options.proposalsRoot,
          request, description, result: { ...result, status: "completed", outcome: result.outcome },
          model: options.model, supportedScope: supportedProposalKind(withProposalChecks(result.outcome.proposal)) !== null }) };
      }
      return { status: "completed",
        exitCode: turn.kind === "task_proposal" && turn.proposedTask.record.status !== "ready" ? 1 : 0, turn };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      session.dispose();
    },
  };
}

export async function createLiveRepositoryConversationForShell(sourceDirectory: string,
  signal?: AbortSignal): Promise<RepositoryConversationForShell> {
  if (signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
  if (process.platform !== "win32") throw new Error("Live repository discovery is currently supported on Windows");
  const credentials = new CodexCredentials();
  const runtime = await ModelRuntime.create({ credentials, refreshOnCreate: false, allowModelNetwork: false,
    ...(signal === undefined ? {} : { signal }) });
  const model = runtime.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
  if (model?.api !== "openai-codex-responses") throw new Error("model unavailable");
  return createRepositoryConversationForShell({ sourceDirectory, proposalsRoot: resolve(homedir(), ".tesota", "proposals"),
    modelRuntime: runtime, model });
}

async function runLiveConversation(rawInput: ConversationInput,
  allowedOutcome: DiscoveryOutcome, writeError: (text: string) => void = (text) => { process.stderr.write(text); },
  hostSignal?: AbortSignal):
Promise<ConversationCommandResult> {
  if (signalAborted(hostSignal)) return { status: "cancelled", exitCode: 130, settlement: "observed" };
  if (process.platform !== "win32") {
    writeError("Live repository discovery is currently supported on Windows.\n");
    return { status: "unavailable", exitCode: 2, reason: "unavailable" };
  }
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort();
  if (signalAborted(hostSignal)) cancellation.abort();
  hostSignal?.addEventListener("abort", interrupt, { once: true });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (cancellation.signal.aborted) throw new DOMException("cancelled", "AbortError");
    const source = await liveSource();
    if (cancellation.signal.aborted) throw new DOMException("cancelled", "AbortError");
    const models = await storedCodexModels(new CodexCredentials(), cancellation.signal);
    const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
    if (model?.api !== "openai-codex-responses") throw new Error("model unavailable");
    const turn = await discoverConversationTurn({ sourceDirectory: source,
      proposalsRoot: resolve(homedir(), ".tesota", "proposals"), input: rawInput, allowedOutcome, model,
      stream: (requested, context, streamOptions) => models.streamSimple(requested, context, streamOptions),
      signal: cancellation.signal });
    return { status: "completed",
      exitCode: turn.kind === "task_proposal" && turn.proposedTask.record.status !== "ready" ? 1 : 0, turn };
  } catch (error) {
    const cancelled = cancelledDiscoveryResult(error, cancellation.signal, writeError);
    if (cancelled !== null) return cancelled;
    if (error instanceof ConversationBaselineChangedError) {
      return { status: "unavailable", exitCode: 1, reason: "baseline_changed" };
    }
    writeError("Repository discovery unavailable or failed; nothing changed and no authority was created.\n");
    return { status: "unavailable", exitCode: 1, reason: "unavailable" };
  } finally {
    cancellation.abort();
    hostSignal?.removeEventListener("abort", interrupt);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

/** Conversational shell turn; questions and change requests share the same read-only boundary. */
export async function runRepositoryConversationCommand(rawRequest: string): Promise<number> {
  const result = await runLiveConversation({ request: rawRequest }, "conversation");
  if (result.status === "completed") process.stdout.write(formatConversationTurn(result.turn));
  return result.exitCode;
}

export async function runRepositoryConversationForShell(input: ConversationInput,
  writeError?: (text: string) => void, signal?: AbortSignal): Promise<ConversationCommandResult> {
  return runLiveConversation(input, "conversation", writeError, signal);
}

/** Explicit proposal command; its narrower contract does not accept answer or clarification results. */
export async function runTaskProposalCommand(rawRequest: string): Promise<number> {
  const result = await runLiveConversation({ request: rawRequest }, "task_proposal");
  if (result.status === "completed") process.stdout.write(formatConversationTurn(result.turn));
  return result.exitCode;
}
