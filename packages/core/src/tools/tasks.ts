import type { EngineTool } from "../tool.ts";
import { invalidTasks, taskParameters as parameters, tasksToolName } from "../tasks.ts";

const nativeTools = new WeakSet<object>();

/** Whether a tool is Tesota's own task tool, never merely a matching name. */
export const isNativeTasksTool = (tool: EngineTool): boolean => nativeTools.has(tool);

/** The agent's task list: one call replaces the whole list, which the session saves once the call's result is synced. */
export function tasksTool(): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: tasksToolName, access: "read", parameters,
    description: "Replace your task list for this request with the whole list given: each task's title and status "
      + "(pending, in_progress, completed or cancelled), at most one in_progress. The operator sees it as your progress; "
      + "an empty list clears it. It is your own claim: it changes neither what the request asks nor what verification checks.",
    promptGuidelines: ["For work with several steps, keep a task list with update_tasks: send the whole list when a step starts "
      + "or ends. Skip it for one-step work. A task marked completed is not evidence that it works."],
    execute: (args) => {
      const invalid = invalidTasks(args);
      return Promise.resolve(invalid === undefined ? { isError: false, text: `Saved ${args.tasks.length} tasks.` } : { isError: true, text: invalid });
    },
  };
  const native = tool as EngineTool;
  nativeTools.add(native);
  return native;
}
