import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type } from "typebox";
import { resolveToolPath } from "../paths.ts";
import type { EngineTool } from "../tool.ts";

const parameters = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

/** Creates or overwrites a file, creating the folders it needs. */
export function writeTool(cwd: string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "write",
    access: "write",
    description: "Write a file, creating it and its folders if needed or replacing what it held.",
    parameters,
    async execute({ path, content }) {
      const file = resolveToolPath(cwd, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
      return { text: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}.`, isError: false };
    },
  };
  return tool as EngineTool;
}
