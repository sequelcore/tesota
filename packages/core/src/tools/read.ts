import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { resolveToolPath } from "../paths.ts";
import type { EngineTool } from "../tool.ts";
import { keepHead, maxBytes, maxLines } from "../truncate.ts";

const parameters = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/** U+FEFF, which some editors put at the start of a UTF-8 file. */
export const byteOrderMark: string = String.fromCharCode(0xfeff);

/** The lines of a text file, without its byte-order mark or a final empty line. */
export function fileLines(content: string): string[] {
  const lines = (content.startsWith(byteOrderMark) ? content.slice(1) : content).split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** Reads a UTF-8 text file, a page at a time when it is long. */
export function readTool(cwd: string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "read",
    access: "read",
    description: `Read a text file. Output stops at ${maxLines} lines or ${maxBytes / 1024} KB, whichever comes first; `
      + "use offset and limit to read the rest.",
    parameters,
    async execute({ path, offset, limit }) {
      const lines = fileLines(await readFile(resolveToolPath(cwd, path), "utf8"));
      const start = Math.max(1, Math.floor(offset ?? 1)) - 1;
      if (start >= lines.length && start > 0) {
        throw new Error(`Offset ${start + 1} is past the end of the file, which has ${lines.length} lines.`);
      }
      const end = limit === undefined ? lines.length : Math.min(lines.length, start + Math.max(0, Math.floor(limit)));
      const kept = keepHead(lines.slice(start, end));
      const shownEnd = start + kept.lines;
      const notice = kept.lines === 0 && kept.truncated
        ? `[Line ${start + 1} is longer than ${maxBytes / 1024} KB; this is its start.]`
        : shownEnd < lines.length ? `[Showing lines ${start + 1}-${shownEnd} of ${lines.length}. Use offset=${shownEnd + 1} to continue.]` : "";
      return { text: notice === "" ? kept.text : `${kept.text}\n\n${notice}`, isError: false };
    },
  };
  return tool as EngineTool;
}
