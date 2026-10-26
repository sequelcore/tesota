import { Type } from "typebox";
import type { Jobs } from "../loop.ts";
import type { EngineTool, ToolOutput } from "../tool.ts";

const parameters = Type.Object({
  prompt: Type.String({ description: "The brief: the task, what to report, and the files or facts it needs; it sees nothing of this conversation" }),
  description: Type.String({ description: "A few words for the operator, such as \"find the failing test\"" }),
  type: Type.Optional(Type.String({ description: "An agent type's name; a general agent when not given" })),
  model: Type.Optional(Type.String({ description: "provider/id of a model its sign-in serves; the type's, then yours, when not given" })),
  writes: Type.Optional(Type.Boolean({ description: "true to let it change files, in a worktree and branch of its own; it only reads when not given" })),
  wait: Type.Optional(Type.Boolean({ description: "true to wait for its report; it runs in the background when not given" })),
});

/** An `agent` call's arguments. */
export interface AgentRequest {
  readonly prompt: string;
  readonly description: string;
  readonly type?: string;
  readonly model?: string;
  readonly writes?: boolean;
  readonly wait?: boolean;
}

/** What starts a session's children (#525): the agent types it knows, and how it starts one as a job of the run. */
export interface AgentHost {
  /** The agent types, listed in the tool's description. */
  readonly catalog: string;
  spawn(request: AgentRequest, callId: string, jobs: Jobs): Promise<ToolOutput>;
}

/**
 * The `agent` tool (#525): it starts a subagent, a session of its own with
 * its own context, on a task. It reads the session's folder, or writes in a
 * worktree of its own, so the call changes nothing in this session's folder,
 * and its own calls pass the session's permissions and hooks. In the
 * background its end comes as a message; with `wait` the call returns it.
 */
export function agentTool(host: AgentHost, jobs: Jobs): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "agent",
    access: "read",
    description: ["Start a subagent: another agent with its own context, on a task you brief it on. It runs in the background "
      + "and its report comes to you as a message when it ends; start several in one reply to run them at once. A subagent that "
      + "writes works in a worktree and branch of its own and ends with its own receipt; what it changed counts only once you bring "
      + "it into your workspace, where your verification checks it. Its report is its own words, never evidence.", host.catalog]
      .filter((part) => part !== "").join("\n\n"),
    promptSnippet: "Start a subagent on a task, in the background or waiting for its report",
    promptGuidelines: ["Give a subagent a complete brief: it sees nothing of your conversation."],
    parameters,
    execute: (request, _signal, callId) => host.spawn(request, callId, jobs),
  };
  return tool as EngineTool;
}
