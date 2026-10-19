import { Type } from "typebox";
import { resolveToolPath } from "../paths.ts";
import { listFiles } from "../ripgrep.ts";
import type { EngineTool } from "../tool.ts";
import { keepHead, maxBytes } from "../truncate.ts";

const parameters = Type.Object({
  pattern: Type.String({ description: "Glob pattern, e.g. **/*.ts" }),
  path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
  limit: Type.Optional(Type.Integer({ minimum: 0, description: "Maximum files (default: 1000)" })),
});

/** Finds files with the same listing used by @ completion. */
export function findTool(cwd: string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "find", access: "read",
    promptSnippet: "Find files by glob",
    description: `Find files by glob, sorted, respecting ignore files. Includes hidden files except .git. Output stops at 1000 files or ${maxBytes / 1024} KB; use limit for more.`,
    parameters,
    async execute({ pattern, path, limit }, signal) {
      const result = await listFiles(resolveToolPath(cwd, path ?? "."), { glob: pattern, limit: limit ?? 1000, signal });
      const kept = keepHead(result.files);
      const omitted = result.omitted + result.files.length - kept.lines;
      return { text: (kept.text || (omitted === 0 ? "No files found matching pattern" : ""))
        + (omitted > 0 ? `\n\n[Output truncated; ${omitted} files omitted. Increase limit or refine pattern.]` : ""), isError: false };
    },
  };
  return tool as EngineTool;
}
