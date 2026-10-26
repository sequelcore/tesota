import { readdir } from "node:fs/promises";
import { Type } from "typebox";
import { resolveToolPath } from "../paths.ts";
import type { EngineTool } from "../tool.ts";
import { keepHead, maxBytes } from "../truncate.ts";

const parameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum entries (default: 500)" })),
});

/** Lists a directory's entries, including hidden entries. */
export function lsTool(cwd: string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "ls", access: "read",
    promptSnippet: "List a folder's entries",
    description: `List directory entries, sorted, with / after folders. Includes hidden entries. Output stops at 500 entries or ${maxBytes / 1024} KB; use limit for more.`,
    parameters,
    async execute({ path, limit }, signal) {
      signal.throwIfAborted();
      const entries = (await readdir(resolveToolPath(cwd, path ?? "."), { withFileTypes: true }))
        .map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).sort();
      signal.throwIfAborted();
      const kept = keepHead(entries.slice(0, limit ?? 500));
      const omitted = entries.length - kept.lines;
      return { text: kept.text + (omitted > 0 ? `\n\n[Output truncated; ${omitted} entries omitted. Increase limit or choose a subfolder.]` : ""), isError: false };
    },
  };
  return tool as EngineTool;
}
