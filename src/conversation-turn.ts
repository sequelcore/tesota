import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { conversationInputSchema, retainedConversationRequest, type AnswerTurn, type ClarificationTurn,
  type ConversationInput } from "./conversation-turn-contract.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { runPiDiscovery, type DiscoveryOutcome, type PiDiscoveryResult } from "./integrations/pi-discovery.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { openRepositoryDiscovery } from "./repository-discovery.js";
import { runRepositoryGit } from "./repository-git.js";
import { formatTaskProposal, retainTaskProposal, type ProposedTask } from "./task-proposal.js";

export type CompletedConversationTurn =
  | { readonly kind: "answer"; readonly answer: AnswerTurn; readonly baseline: string }
  | { readonly kind: "clarification"; readonly clarification: ClarificationTurn; readonly baseline: string }
  | { readonly kind: "task_proposal"; readonly proposedTask: ProposedTask };

class ConversationBaselineChangedError extends Error {
  constructor() { super("Clarification baseline changed"); }
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
  if (result.status !== "completed" || result.outcome === null) throw new Error("Repository discovery failed");
  if (result.outcome.kind === "answer") {
    return { kind: "answer", answer: result.outcome, baseline: description.baseline };
  }
  if (result.outcome.kind === "clarification") {
    return { kind: "clarification", clarification: result.outcome, baseline: description.baseline };
  }
  const request = input.clarification === undefined ? input.request : retainedConversationRequest(input);
  return { kind: "task_proposal", proposedTask: await retainTaskProposal({ proposalsRoot: options.proposalsRoot,
    request, description, result: { ...result, outcome: result.outcome }, model: options.model }) };
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

async function liveSource(): Promise<string | null> {
  const source = await realpath(runRepositoryGit(process.cwd(), ["rev-parse", "--show-toplevel"]).trim());
  const packageRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  return relative(packageRoot, source) === "" ? source : null;
}

export type ConversationCommandResult =
  | Readonly<{ status: "completed"; exitCode: number; turn: CompletedConversationTurn }>
  | Readonly<{ status: "unavailable"; exitCode: number; reason: "baseline_changed" | "unavailable" }>;

async function runLiveConversation(rawInput: ConversationInput,
  allowedOutcome: DiscoveryOutcome, writeError: (text: string) => void = (text) => { process.stderr.write(text); },
  hostSignal?: AbortSignal):
Promise<ConversationCommandResult> {
  if (process.platform !== "win32") {
    writeError("Live repository discovery is currently supported on Windows.\n");
    return { status: "unavailable", exitCode: 2, reason: "unavailable" };
  }
  const cancellation = new AbortController();
  const interrupt = (): void => cancellation.abort();
  if (hostSignal?.aborted === true) cancellation.abort();
  hostSignal?.addEventListener("abort", interrupt, { once: true });
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    if (cancellation.signal.aborted) throw new DOMException("cancelled", "AbortError");
    const source = await liveSource();
    if (source === null) {
      writeError("Live repository discovery currently supports only the Tesota repository root.\n");
      return { status: "unavailable", exitCode: 2, reason: "unavailable" };
    }
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
    if (cancellation.signal.aborted) throw new DOMException("cancelled", "AbortError");
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
