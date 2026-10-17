import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Hooks, readHooks } from "./hooks.ts";
import { type McpConfig, type McpServerConfig, projectServers, readMcpConfig } from "./mcp-config.ts";
import { trustHash, trusted } from "./trust.ts";
import { checkoutRoot } from "./workspace.ts";

/** A file's hooks, or why they were left out. */
export type HooksRead = Hooks | string;

/**
 * The command hooks (#457) and MCP servers (#459) a session in `cwd` runs:
 * the operator's, beside their settings, and the project's, in its
 * `.tesota` folder, with whether the operator trusts the project's as they
 * are now. The shell asks about those not trusted; print mode leaves them out.
 */
export interface Standards {
  readonly root: string;
  readonly ownHooks: HooksRead;
  readonly projectHooks: { readonly hooks: HooksRead; readonly hash: string; readonly trusted: boolean };
  readonly mcp: {
    readonly own: string;
    readonly project: string;
    /** Both files read together, the project's included. */
    readonly config: McpConfig;
    /** The project's servers that run its commands or turn on the operator's, which its trust covers. */
    readonly theirs: readonly McpServerConfig[];
    readonly hash: string;
    readonly trusted: boolean;
  };
}

const readOr = (path: string): HooksRead => {
  try { return readHooks(path); } catch (error) { return error instanceof Error ? error.message : String(error); }
};

export function readStandards(cwd: string, settingsPath: string): Standards {
  const root = checkoutRoot(resolve(cwd));
  const project = readOr(join(root, ".tesota", "settings.json"));
  const hooksHash = typeof project === "string" ? "" : trustHash(project);
  const own = join(dirname(settingsPath), "mcp.json");
  const projectMcp = join(root, ".tesota", "mcp.json");
  const config = readMcpConfig(own, projectMcp, resolve(cwd));
  const theirs = projectServers(config, projectMcp);
  // Trust goes to the file as written, so a changed entry asks again and a changed environment variable does not.
  const mcpHash = theirs.length === 0 ? "" : trustHash(readFileSync(projectMcp, "utf8"));
  return {
    root,
    ownHooks: readOr(settingsPath),
    projectHooks: { hooks: project, hash: hooksHash, trusted: typeof project !== "string" && trusted(root, "hooks", hooksHash) },
    mcp: { own, project: projectMcp, config, theirs, hash: mcpHash, trusted: theirs.length === 0 || trusted(root, "mcp", mcpHash) },
  };
}
