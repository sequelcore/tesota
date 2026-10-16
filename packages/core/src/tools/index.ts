import type { EngineTool } from "../tool.ts";
import { editTool } from "./edit.ts";
import { readTool } from "./read.ts";
import { platformShell, type Shell, shellTool } from "./shell.ts";
import { writeTool } from "./write.ts";

/** The agent's tools in `cwd`: read, write, edit and the platform's shell, whose long output goes under `spool()`. */
export function codingTools(cwd: string, spool: () => string, shell: Shell = platformShell()): EngineTool[] {
  return [readTool(cwd), writeTool(cwd), editTool(cwd), shellTool(cwd, shell, spool)];
}
