import type { EngineTool } from "../tool.ts";
import { askTool, type AskHost } from "./ask.ts";
import { editTool } from "./edit.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { platformShell, type Shell, shellTool } from "./shell.ts";
import { writeTool } from "./write.ts";

/** The agent's file tools and the platform's shell, whose long output goes under `spool()`. */
export function codingTools(cwd: string, spool: () => string, shell: Shell = platformShell(), ask?: AskHost): EngineTool[] {
  return [readTool(cwd), lsTool(cwd), findTool(cwd), grepTool(cwd), writeTool(cwd), editTool(cwd), shellTool(cwd, shell, spool),
    ...ask === undefined ? [] : [askTool(ask)]];
}
