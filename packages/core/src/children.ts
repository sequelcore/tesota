import type { Api, Model } from "@earendil-works/pi-ai";
import { entryReceipt, isReceipt, type Receipt, receiptStanding, renderReceipt } from "../../../src/receipt.ts";
import { type AgentType, agentCatalog } from "./agents.ts";
import { admitChild, childMode } from "./agent-rule.ts";
import { branchOf } from "./branch.ts";
import { contextFiles, instructionsText, skillCatalog, skills } from "./instructions.ts";
import type { JobEnd } from "./loop.ts";
import type { EngineSession, SessionOptions } from "./session.ts";
import { peekSessionFile, type SessionEntry, type SessionHeader } from "./session-file.ts";
import type { EngineTool, ToolOutput } from "./tool.ts";
import type { AgentHost, AgentRequest } from "./tools/agent.ts";
import { codingTools } from "./tools/index.ts";
import { newWorktree, type Workspace } from "./workspace.ts";

/** How far below its top session a child may be (#525): two, as pstack's `orchestrate` playbook spawns sub-coordinators. */
export const maxDepth = 2;

/** How many children run at once across a top session's tree when the settings do not say (#525). */
export const defaultAgentLimit = 4;

/** The model replies a child may take, and the time it may run, before it is stopped (#525). */
export const childLimits = { turns: 100, minutes: 60 };

/** The children running across one top session's tree, counted against its limit (#525). */
export interface AgentTree {
  running: number;
  readonly limit: number;
}

/** What a child's end reports (#525): to the shell, the parent's receipt and the operator; the report itself is never evidence. */
export interface ChildReport {
  readonly description: string;
  readonly type?: string;
  readonly model: string;
  readonly depth: number;
  readonly writes: boolean;
  /** How the child's run ended, `unknown` when the process ended first; `running` until it ends. */
  readonly outcome: string;
  /** Where the child's receipt stands, when its run settled with one. */
  readonly verification?: "verified" | "incomplete" | "failed";
  /** The limit that stopped it, when one did. */
  readonly limited?: "turns" | "time";
  readonly session: string;
  /** A writing child's branch and worktree, when it changed something and they stay. */
  readonly branch?: string;
  readonly worktree?: string;
}

/** A session's place to start children from: what it is, where it works, and how it makes a session (`createSession`). */
export interface Parent {
  readonly id: string;
  readonly folder: string;
  readonly depth: number;
  readonly workspace: Pick<Workspace, "cwd" | "checkout">;
  readonly options: Omit<SessionOptions, "cwd" | "folder">;
  readonly types: readonly AgentType[];
  readonly tree: AgentTree;
  readonly create: (options: SessionOptions) => EngineSession;
}

const label = (model: Model<Api>): string => `${model.provider}/${model.id}`;

const refused = (text: string): ToolOutput => ({ text: `Not started: ${text}`, isError: true });

/** What a child is told about being one, after the project's instructions and before its type's. */
function childInstructions(writes: boolean, branch: string | undefined): string {
  return ["You are a subagent: another agent's session started you on one task, your request below. Your last message is your "
    + "report to it; it reads that, not your other messages, so end with what you found or did and what you could not verify. "
    + "No operator answers you here: decide with what you have, and say what you assumed.",
  writes ? `You work in a worktree of your own${branch === undefined ? "" : `, on branch ${branch}`}. Commit your work on that branch `
    + "before you finish, so the agent that started you can bring it in." : "You only read: change nothing."].join("\n\n");
}

/**
 * The models a child can run on (#563): those of the providers Tesota is
 * signed in to, but with ChatGPT sign-in only the OpenAI models it serves, as
 * `GET /models` on its token lists them; OpenAI refuses the rest of its
 * catalog at the first request.
 */
async function runnable(models: SessionOptions["models"]): Promise<readonly Model<Api>[]> {
  const available = await models.getAvailable();
  if ((await models.checkAuth("openai"))?.type !== "oauth") return available;
  const token = (await models.getAuth("openai"))?.auth.apiKey;
  const response = await fetch(`${models.getProvider("openai")?.baseUrl}/models`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OpenAI did not list the models the ChatGPT sign-in serves (${response.status}).`);
  const listed = (await response.json() as { models?: readonly { slug?: unknown }[] }).models ?? [];
  const served = new Set(listed.map(({ slug }) => slug));
  return available.filter((model) => model.provider !== "openai" || served.has(model.id));
}

/** The model a child runs on: the call's, then its type's, then its parent's, among those it can run on. */
async function modelFor(parent: Parent, request: AgentRequest, type: AgentType | undefined): Promise<Model<Api> | string> {
  const named = request.model ?? type?.model;
  if (named === undefined) return parent.options.model;
  let available: readonly Model<Api>[];
  try { available = await runnable(parent.options.models); } catch (error) { return error instanceof Error ? error.message : String(error); }
  const found = available.find((model) => label(model) === named);
  return found ?? `no model ${named} among those Tesota can run: ${available.map(label).join(", ") || "none"}.`;
}

/** What the model reads of a child's end: its report, labeled as the child's words, then its receipt and where its work is. */
function endText(report: ChildReport, said: string | undefined, receipt: Receipt | undefined, failure: string | undefined): string {
  const stopped = report.limited === "turns" ? ` after ${childLimits.turns} replies, its limit`
    : report.limited === "time" ? ` after ${childLimits.minutes} minutes, its limit` : "";
  return [`Subagent "${report.description}" ended ${report.outcome}${stopped}${report.verification === undefined ? "" : `, ${report.verification}`}.`,
    ...failure === undefined ? [] : [`It failed: ${failure}`],
    `Its report, in its own words (not evidence):\n${said?.trim() || "(it said nothing)"}`,
    ...receipt === undefined ? [] : [renderReceipt(receipt)],
    ...report.branch === undefined ? [] : [`Its work is on branch ${report.branch}, in ${report.worktree ?? "its worktree"}. `
      + "It counts toward your request only once you bring it into your workspace, where your verification checks it."],
    `Its session: ${report.session}`].join("\n\n");
}

/** The last receipt a child's session settled with, as `tesota -p` reads it, since a child records it as data. */
function lastReceipt(entries: readonly SessionEntry[]): Receipt | undefined {
  const found = branchOf(entries).map(entryReceipt).findLast((receipt) => receipt !== undefined);
  return isReceipt(found) ? found : undefined;
}

/**
 * Runs `child` on `brief` within the limits, stopped on `signal`, then lets
 * go of it: the report and receipt it ended with, and a writer's branch when
 * its worktree stays.
 */
async function runChild(child: EngineSession, brief: string, report: ChildReport, signal: AbortSignal): Promise<JobEnd> {
  let limited: ChildReport["limited"];
  let replies = 0;
  const stop = (): void => { void child.abort(); };
  const unsubscribe = child.subscribe((event) => {
    if (event.type !== "message" || event.message.role !== "assistant" || ++replies <= childLimits.turns) return;
    limited ??= "turns";
    stop();
  });
  const timer = setTimeout(() => { limited ??= "time"; stop(); }, childLimits.minutes * 60_000);
  signal.addEventListener("abort", stop, { once: true });
  let failure: string | undefined;
  try {
    if (!signal.aborted) await child.prompt(brief, { source: "rpc" });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    unsubscribe();
  }
  const said = child.lastAssistantText();
  await child.dispose();
  const written = peekSessionFile(child.file).entries;
  const receipt = lastReceipt(written);
  const outcome = child.outcome() ?? (signal.aborted ? "aborted" : "error");
  // A run that ends in error, such as on a provider's refusal, says why in its end (#564).
  if (outcome === "error") failure ??= written.flatMap((entry) => entry.type === "run_end" ? [entry.reason] : []).at(-1);
  const verification = receipt === undefined ? undefined : receiptStanding(receipt);
  const kept = child.kept() !== undefined && child.workspace.branch !== undefined;
  const ended: ChildReport = { ...report, outcome, ...verification === undefined ? {} : { verification },
    ...limited === undefined ? {} : { limited },
    ...kept ? { branch: child.workspace.branch as string, worktree: child.workspace.worktree as string } : {} };
  return { outcome, text: endText(ended, said, receipt, failure), details: ended as never };
}

/**
 * The children `parent` starts (#525). A child is a session in the same
 * sessions folder, its parent in its header, on the call's brief: one that
 * only reads shares the parent's folder with the read tools, read only; one
 * that writes always gets a worktree of its own and the parent's mode. It
 * has no one to ask, and starts children of its own while it is less than
 * two below the top session. Each runs as a job of the parent's run, within
 * the tree's limit and its own turns and time.
 */
export function agentHost(parent: Parent): AgentHost {
  return {
    catalog: agentCatalog(parent.types, parent.options.model.contextWindow),
    spawn: async (request, callId, jobs) => {
      const type = request.type === undefined ? undefined : parent.types.find(({ name }) => name === request.type);
      if (request.type !== undefined && type === undefined) {
        return refused(`no agent type ${request.type}; there are ${parent.types.map(({ name }) => name).join(", ") || "none"}.`);
      }
      const writes = request.writes ?? type?.writes === true;
      const background = !(request.wait ?? type?.background === false);
      const mode = parent.options.permissions?.mode() ?? "full";
      const admission = admitChild(parent.depth, maxDepth, parent.tree.running, parent.tree.limit, writes, mode === "read");
      if (admission === "too_deep") return refused(`a subagent ${maxDepth} below the top session starts none of its own.`);
      if (admission === "read_only") return refused("the session is read only, so it starts no subagent that writes.");
      if (admission === "too_many") return refused(`${parent.tree.limit} subagents already run; wait for one to end.`);
      const model = await modelFor(parent, request, type);
      if (typeof model === "string") return refused(model);
      const depth = parent.depth + 1;
      parent.tree.running += 1;
      let counted = true;
      const uncount = (): void => { if (counted) { counted = false; parent.tree.running -= 1; } };
      try {
        const started = await jobs.start((job) => {
          const header: NonNullable<SessionHeader["parent"]> = { session: parent.id, job, depth };
          const child = parent.create(childOptions(parent, { header, writes, model, type }));
          const report: ChildReport = { description: request.description, ...type === undefined ? {} : { type: type.name },
            model: label(model), depth, writes, outcome: "running", session: child.file };
          return {
            start: { callId, kind: "agent", description: request.description, background, session: child.file, details: report as never },
            work: (signal) => runChild(child, request.prompt, report, signal).finally(uncount),
            discard: async () => { await child.dispose(); uncount(); },
          };
        });
        if (started.end !== undefined) return { text: started.end.text, isError: started.end.outcome !== "completed", details: started.end.details };
        return { text: `Started subagent "${request.description}" (job ${started.job}) in the background. Its report comes to you `
          + "as a message when it ends; go on meanwhile, or end your reply to wait for it.", isError: false };
      } catch (error) {
        uncount();
        return refused(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** The options a child of `parent` opens with. */
function childOptions(parent: Parent, child: { readonly header: NonNullable<SessionHeader["parent"]>; readonly writes: boolean;
  readonly model: Model<Api>; readonly type: AgentType | undefined }): SessionOptions {
  const { permissions, mcp, questions: _questions, surface: _surface, instructions: _instructions, tools: _tools, child: _child,
    ...inherited } = parent.options;
  const { cwd, checkout } = parent.workspace;
  const bind = child.writes
    ? (id: string): Workspace => newWorktree(cwd, id, `${cwd} is not a Git repository with a commit, so a subagent that writes `
      + "has no worktree of its own to work in.")
    : (): Workspace => ({ cwd, checkout, release: () => undefined });
  return {
    ...inherited, cwd, folder: parent.folder, model: child.model, mode: "print",
    child: { parent: child.header, bind, tree: parent.tree, types: parent.types,
      instructions: (at, branch) => [instructionsText(contextFiles(at), skillCatalog(skills(at), child.model.contextWindow)),
        childInstructions(child.writes, branch), child.type?.instructions ?? ""].filter((part) => part !== "").join("\n\n") },
    tools: (spool: () => string, at: string): readonly EngineTool[] => codingTools(at, spool)
      .filter((tool) => child.writes || tool.access === "read"),
    // One that only reads reaches the parent's MCP servers, which run in its folder; one that writes has none in its worktree yet.
    ...mcp === undefined || child.writes ? {} : { mcp },
    ...permissions === undefined ? {} : { permissions: { ...permissions, mode: () => childMode(permissions.mode(), child.writes) } },
  };
}
