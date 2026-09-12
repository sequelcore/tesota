import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import * as z from "zod";
import type { AnswerTurn, ClarificationTurn } from "./conversation-turn-contract.js";
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

export async function discoverConversationTurn(options: {
  readonly sourceDirectory: string;
  readonly proposalsRoot: string;
  readonly request: string;
  readonly allowedOutcome: DiscoveryOutcome;
  readonly model: Model<Api>;
  readonly stream: StreamFn;
  readonly signal: AbortSignal;
}): Promise<CompletedConversationTurn> {
  const request = z.string().trim().min(1).max(8_000).parse(options.request);
  const discovery = await openRepositoryDiscovery(options.sourceDirectory);
  const description = discovery.describe();
  let result: PiDiscoveryResult;
  try {
    result = await runPiDiscovery(discovery, request, options.allowedOutcome, options.model, options.stream, options.signal);
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

export interface ConversationCommandResult {
  readonly exitCode: number;
  readonly proposalId?: string;
}

async function runLiveConversation(rawRequest: string, allowedOutcome: DiscoveryOutcome): Promise<ConversationCommandResult> {
  if (process.platform !== "win32") {
    process.stderr.write("Live repository discovery is currently supported on Windows.\n");
    return { exitCode: 2 };
  }
  try {
    const source = await liveSource();
    if (source === null) {
      process.stderr.write("Live repository discovery currently supports only the Tesota repository root.\n");
      return { exitCode: 2 };
    }
    const cancellation = new AbortController();
    const interrupt = (): void => cancellation.abort();
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    try {
      const models = await storedCodexModels(new CodexCredentials(), cancellation.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("model unavailable");
      const turn = await discoverConversationTurn({ sourceDirectory: source,
        proposalsRoot: resolve(homedir(), ".tesota", "proposals"), request: rawRequest, allowedOutcome, model,
        stream: (requested, context, streamOptions) => models.streamSimple(requested, context, streamOptions),
        signal: cancellation.signal });
      process.stdout.write(formatConversationTurn(turn));
      return turn.kind === "task_proposal" ? {
        exitCode: turn.proposedTask.record.status === "ready" ? 0 : 1,
        ...(turn.proposedTask.record.status === "ready" ? { proposalId: turn.proposedTask.record.id } : {}),
      } : { exitCode: 0 };
    } finally {
      cancellation.abort();
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  } catch {
    process.stderr.write("Repository discovery unavailable or failed; nothing changed and no authority was created.\n");
    return { exitCode: 1 };
  }
}

/** Conversational shell turn; questions and change requests share the same read-only boundary. */
export async function runRepositoryConversationCommand(rawRequest: string): Promise<number> {
  return (await runLiveConversation(rawRequest, "conversation")).exitCode;
}

export async function runRepositoryConversationForShell(rawRequest: string): Promise<ConversationCommandResult> {
  return runLiveConversation(rawRequest, "conversation");
}

/** Explicit proposal command; its narrower contract does not accept answer or clarification results. */
export async function runTaskProposalCommand(rawRequest: string): Promise<number> {
  return (await runLiveConversation(rawRequest, "task_proposal")).exitCode;
}
