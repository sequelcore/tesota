import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Type } from "typebox";
import { resolveToolPath } from "../paths.ts";
import { judge } from "../permissions.ts";
import { listFiles, runRipgrep } from "../ripgrep.ts";
import type { EngineTool } from "../tool.ts";
import { keepHead, maxBytes, maxLines } from "../truncate.ts";

const parameters = Type.Object({
  pattern: Type.String({ description: "Regular expression to search for" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob, e.g. *.ts" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  context: Type.Optional(Type.Integer({ minimum: 0, description: "Lines before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum matching lines (default: 100)" })),
});

/** Text in a ripgrep JSON record, which uses base64 when the file is not UTF-8. */
function recordText(value: { text?: string; bytes?: string } | undefined): string {
  return value?.text ?? Buffer.from(value?.bytes ?? "", "base64").toString("utf8");
}

/** Searches with ripgrep's JSON records so context never counts as a match. */
export function grepTool(cwd: string): EngineTool {
  const tool: EngineTool<typeof parameters> = {
    name: "grep", access: "read",
    promptSnippet: "Search file contents by regular expression",
    description: `Search file contents by regular expression, with file names and line numbers. Respects ignore files; includes hidden files except .git. Output stops at 100 matching lines or ${maxBytes / 1024} KB; use limit or refine the pattern for more.`,
    parameters,
    async execute({ pattern, path, glob, ignoreCase, context, limit }, signal) {
      signal.throwIfAborted();
      const search = resolveToolPath(cwd, path ?? ".");
      const directory = (await stat(search)).isDirectory();
      const deadline = performance.now() + 10_000;
      const root = directory ? search : dirname(search);
      if (!directory && judge({ type: "toolCall", id: "", name: "read", arguments: { path: search } }, "read", cwd, "read", [], false).decision === "deny") {
        throw new Error("The read permission floor refuses this path.");
      }
      const listed = await listFiles(root, { ...glob === undefined ? {} : { glob }, limit: Number.MAX_SAFE_INTEGER, signal });
      const files = directory ? listed.files : listed.files.filter((file) => file === basename(search));
      const lines: string[] = [];
      let matches = 0, bytes = 0, truncated = false;
      for (let start = 0; start < files.length;) {
        const batch: string[] = [];
        let length = 0;
        do {
          const file = `./${files[start]}`;
          batch.push(file);
          length += file.length + 3;
          start++;
        } while (start < files.length && length < 8_000);
        await runRipgrep(root, ["--json", "--line-number", "--with-filename", "--sort=path",
          ...ignoreCase === true ? ["--ignore-case"] : [],
          "--context", String(context ?? 0), "--regexp", pattern, "--", ...batch], signal, (record) => {
          if (record === "") return true;
          const event = JSON.parse(record) as { type: string; data: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number } };
          if (event.type !== "match" && event.type !== "context") return true;
          const file = recordText(event.data.path).replaceAll("\\", "/").replace(/^\.\//u, "");
          if (event.type === "match" && ++matches > (limit ?? 100)) { truncated = true; return false; }
          const text = recordText(event.data.lines).replace(/\r?\n$/u, "");
          const separator = event.type === "match" ? ":" : "-";
          const line = `${file}${separator}${event.data.line_number}${separator}${text}`;
          lines.push(line);
          bytes += Buffer.byteLength(line) + 1;
          if (bytes > maxBytes || lines.length > maxLines) { truncated = true; return false; }
          return true;
        }, deadline - performance.now());
        if (truncated) break;
      }
      const kept = keepHead(lines);
      return { text: (kept.text || "No matches found")
        + (truncated || kept.truncated ? "\n\n[Output truncated. Increase limit or refine the pattern or path.]" : ""), isError: false };
    },
  };
  return tool as EngineTool;
}
