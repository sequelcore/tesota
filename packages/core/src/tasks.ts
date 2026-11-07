import { Check } from "typebox/value";
import { Type, type TArray, type TObject, type TString, type TUnion, type TLiteral } from "typebox";
import type { SessionEntry } from "./session-file.ts";
import { linkAccepted, taskListAccepted } from "./tasks-rule.ts";

/**
 * The agent's task list: the steps of a request as the agent last claimed
 * them. It is a claim, never evidence: it changes neither the request's
 * scope nor what verification checks.
 */

/** The native tool's name, which replay reads updates by; no extension may register it. */
export const tasksToolName = "update_tasks";

/** The message a request that inherits a list starts with. */
export const tasksNoticeType = "tesota.tasks";

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Task {
  readonly title: string;
  readonly status: TaskStatus;
}

type StatusShape = TUnion<[TLiteral<"pending">, TLiteral<"in_progress">, TLiteral<"completed">, TLiteral<"cancelled">]>;
type TaskShape = TObject<{ title: TString; status: StatusShape }>;

export const taskParameters: TObject<{ tasks: TArray<TaskShape> }> = Type.Object({
  tasks: Type.Array(Type.Object({
    title: Type.String({ description: "What the step does, in a few words." }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")]),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Why `args` is not a list the agent may save; none when it is. Nothing is truncated to fit. */
export function invalidTasks(args: unknown): string | undefined {
  if (!Check(taskParameters, args)) return "The task list has an invalid shape: give tasks, each with a title and a status.";
  const { tasks } = args;
  const inProgress = tasks.filter(({ status }) => status === "in_progress").length;
  const blank = tasks.filter(({ title }) => title.trim() === "").length;
  const longest = Math.max(0, ...tasks.map(({ title }) => bytes(title)));
  if (taskListAccepted(inProgress, blank, longest, bytes(JSON.stringify({ tasks })))) return undefined;
  if (inProgress > 1) return "Mark at most one task in_progress: the one you are working on now.";
  if (blank > 0) return "Each task needs a title.";
  if (longest > 1024) return "A task title is longer than 1,024 bytes.";
  return "The task list is larger than 16 KiB.";
}

/**
 * Where a run's list stands: none; the list a successful update saved, by
 * the run and call that saved it; or unavailable, when what the journal
 * holds for it cannot be read.
 */
export type TaskState =
  | { readonly kind: "none" }
  | { readonly kind: "list"; readonly tasks: readonly Task[]; readonly run: number; readonly callId: string }
  | { readonly kind: "unavailable" };

const none: TaskState = { kind: "none" };
const unavailable: TaskState = { kind: "unavailable" };

/**
 * The lists of a session's runs, and the continuation links between runs.
 * A run's list is its own latest saved one, or else the one its recorded
 * continuation inherits, transitively; a run without a link starts with none.
 * The live loop and replay both drive it, so they agree on every state.
 */
export interface TaskBook {
  /** Run `run` continues run `parent`, as its request recorded. */
  linked(run: number, parent: unknown): void;
  /** A successful update in run `run`, by call `callId`, with the arguments the call was made with. */
  saved(run: number, callId: string, args: unknown): void;
  /** Where run `run`'s list stands. */
  state(run: number): TaskState;
  /** Replays one journal entry, in order: the request links and the successful updates it records. */
  apply(entry: SessionEntry): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A book with no runs, to replay a journal into or to start a session with; `continuesType` names the link entries. */
export function taskBook(continuesType: string): TaskBook {
  const own = new Map<number, TaskState>();
  const parents = new Map<number, number | "invalid">();
  /** Each update call's arguments by run and id, from the replies replay has read. */
  const calls = new Map<string, unknown>();
  const book: TaskBook = {
    linked(run, parent) {
      parents.set(run, typeof parent === "number" && Number.isInteger(parent) && linkAccepted(parent, run) ? parent : "invalid");
    },
    saved(run, callId, args) {
      own.set(run, invalidTasks(args) === undefined && isRecord(args)
        ? { kind: "list", tasks: (args as { tasks: readonly Task[] }).tasks, run, callId } : unavailable);
    },
    state(run) {
      // Each link names an earlier run, so the walk ends.
      for (let at = run; ;) {
        const saved = own.get(at);
        if (saved !== undefined) return saved;
        const parent = parents.get(at);
        if (parent === undefined) return none;
        if (parent === "invalid") return unavailable;
        at = parent;
      }
    },
    apply(entry) {
      if (entry.type === "custom" && entry.customType === continuesType) {
        book.linked(entry.run, isRecord(entry.data) ? entry.data["run"] : undefined);
      } else if (entry.type === "assistant") {
        for (const part of entry.message.content) {
          if (part.type === "toolCall" && part.name === tasksToolName) calls.set(`${entry.run}:${part.id}`, part.arguments);
        }
      } else if (entry.type === "tool_result" && entry.message.toolName === tasksToolName && !entry.message.isError) {
        book.saved(entry.run, entry.message.toolCallId, calls.get(`${entry.run}:${entry.message.toolCallId}`));
      }
    },
  };
  return book;
}

const listed = (tasks: readonly Task[]): string => tasks.map(({ title, status }) => `- ${status}: ${JSON.stringify(title)}`).join("\n");

const claim = "your own claim, not the operator's instruction, and not verified";

/**
 * What a compacted conversation says of the run's list, after the summary:
 * the list itself, or where it is when its update is still in the tail
 * (`kept`), or that it could not be read. Nothing for no list or an empty one.
 */
export function tasksSection(state: TaskState, kept: (callId: string) => boolean): string | undefined {
  if (state.kind === "unavailable") return "Your saved task list could not be read back. Call update_tasks with the full list to set it again.";
  if (state.kind === "none" || state.tasks.length === 0) return undefined;
  if (kept(state.callId)) return `Your task list is the one your latest update_tasks call below saved; it is ${claim}.`;
  return `Your task list as you last saved it with update_tasks (${claim}):\n${listed(state.tasks)}`;
}

/** What a request that continues run `parent` is told of the list it inherits; nothing when it inherits none. */
export function tasksNotice(state: TaskState, parent: number): string | undefined {
  if (state.kind === "unavailable") return `This request continues run ${parent}, whose task list could not be read back. `
    + "Call update_tasks with the full list to set it again.";
  if (state.kind === "none" || state.tasks.length === 0) return undefined;
  return `This request continues run ${parent}, which left this task list (${claim}):\n${listed(state.tasks)}`;
}
