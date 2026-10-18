import { join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { provideHost } from "../../../src/host.ts";
import { entryReceipt, isReceipt, receiptStanding } from "../../../src/receipt.ts";
import tesota from "../../../src/tesota.ts";
import { branchOf } from "./branch.ts";
import { anyHooks, type Hooks, joinHooks } from "./hooks.ts";
import type { McpServers } from "./mcp.ts";
import { type McpServerConfig, readMcpConfig } from "./mcp-config.ts";
import { chosenModel, engineModels } from "./model-access.ts";
import { loadRules } from "./permissions.ts";
import { createSession, type EngineSession } from "./session.ts";
import { peekSessionFile } from "./session-file.ts";
import { readSettings } from "./settings.ts";
import { shellHost } from "./shell/surface.ts";
import { readStandards } from "./standards.ts";

export interface PrintOutput {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

const usage = "tesota -p \"<request>\" [--model <provider>/<id>]";

/** The request and model `-p`'s arguments name, or what is wrong with them. */
function parse(args: readonly string[]): { request: string; model?: string } | string {
  let request: string | undefined;
  let model: string | undefined;
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? "";
    if (arg === "--model" && (args[at + 1] ?? "").includes("/")) model = args[++at];
    else if (arg.startsWith("--model=") && arg.includes("/", 8)) model = arg.slice(8);
    else if (!arg.startsWith("-") && request === undefined) request = arg;
    else return `${arg} is not something tesota -p takes. Use: ${usage}`;
  }
  if (request === undefined || request.trim() === "") return `Say what to do. Use: ${usage}`;
  return { request, ...model === undefined ? {} : { model } };
}

/**
 * The hooks print mode runs and the MCP files it reads: yours, and the
 * project's once trusted in the shell, since there is no one to ask; it says
 * what it leaves out.
 */
function trustedStandards(cwd: string, settingsPath: string, write: PrintOutput): { hooks: Hooks; mcp: { own: string; project?: string } } {
  const standards = readStandards(cwd, settingsPath);
  const own = typeof standards.ownHooks === "string" ? {} : standards.ownHooks;
  const project = standards.projectHooks;
  for (const [whose, read] of [["Your", standards.ownHooks], ["The project's", project.hooks]] as const) {
    if (typeof read === "string") write.error(`${whose} hooks were left out: ${read}\n`);
  }
  const untrusted = typeof project.hooks !== "string" && anyHooks(project.hooks) && !project.trusted;
  if (untrusted) write.error("The project's hooks do not run: trust them in the shell first.\n");
  for (const error of standards.mcp.config.errors) write.error(`${error}\n`);
  if (!standards.mcp.trusted) write.error("The project's MCP servers do not start: trust them in the shell first.\n");
  return { hooks: typeof project.hooks !== "string" && project.trusted ? joinHooks(own, project.hooks) : own,
    mcp: { own: standards.mcp.own, ...standards.mcp.trusted ? { project: standards.mcp.project } : {} } };
}

/** How the run ended and where its verification stands, from the receipt it settled with. */
function ending(outcome: string | undefined, file: string): string {
  const receipt = branchOf(peekSessionFile(file).entries).map(entryReceipt).findLast((found) => found !== undefined);
  return `${outcome === "completed" ? "Completed" : `Ended ${outcome ?? "without a run"}`}`
    + `${isReceipt(receipt) ? `, ${receiptStanding(receipt)}; tesota receipt writes it for a pull request` : ""}.\n`;
}

/** The MCP servers of the folder the session works in, its worktree's when it has one, so they never act in another session's (#459). */
async function serversFor(session: EngineSession, mcp: { own: string; project?: string }): Promise<McpServers | undefined> {
  const { servers }: { servers: readonly McpServerConfig[] } = readMcpConfig(mcp.own, mcp.project, session.workspace.cwd);
  if (servers.length === 0) return undefined;
  const { startMcp } = await import("./mcp.ts");
  return startMcp(servers, { cwd: resolve(session.workspace.cwd) });
}

/**
 * `tesota -p "<request>"` in `cwd` (#463): one request without the shell,
 * verified as every run is, on the chosen model or `--model`, with the
 * verifier's `flags`. The answer goes to standard output, where the
 * verification stands and how to read the receipt to standard error. It runs
 * your hooks and MCP servers and the project's only once trusted in the
 * shell, since there is no one to ask; for the same reason a call that would
 * ask is refused. Ctrl+C or a termination stops the run and lets go of what
 * it holds before exiting. Exits 0 when the run completed, 1 when it did not
 * or was stopped, 2 for arguments it does not take.
 */
export async function runPrint(args: readonly string[], cwd: string, write: PrintOutput,
  flags: Readonly<Record<string, string>> = {}, settingsPath: string = join(tesotaHome(), "settings.json")): Promise<number> {
  const asked = parse(args);
  if (typeof asked === "string") { write.error(`${asked}\n`); return 2; }
  const { settings } = readSettings(settingsPath);
  const models = engineModels();
  const [provider, ...id] = asked.model?.split("/") ?? [];
  const model = provider === undefined ? chosenModel(models, settings) : models.getModel(provider, id.join("/"));
  if (model === undefined) {
    write.error(asked.model === undefined ? "No model: run tesota, then /login and /model.\n" : `No model ${asked.model}.\n`);
    return 1;
  }
  provideHost(shellHost());
  const { hooks, mcp } = trustedStandards(cwd, settingsPath, write);
  const rules = loadRules(cwd);
  let servers: McpServers | undefined;
  const session = createSession({ cwd, models, model, verifier: (pi, request) => { tesota(pi, request); }, mode: "print", flags,
    hooks: () => hooks, mcp: () => servers,
    permissions: { mode: () => settings.permissionMode ?? "ask", rules },
    ...settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel } });
  let stopped = false;
  const stop = (): void => { stopped = true; void session.abort(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    servers = await serversFor(session, mcp);
    // A request stopped before it began is refused rather than run; that is the stop, not a failure to report.
    await session.prompt(asked.request).catch((error: unknown) => { if (!stopped) throw error; });
    write.out(`${session.lastAssistantText() ?? ""}\n`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // Each is let go of whatever the other does, so a session that fails to close never leaves its servers running.
    await Promise.allSettled([session.dispose(), servers?.close()]);
  }
  write.error(ending(session.outcome(), session.file));
  const kept = session.kept();
  if (kept !== undefined) write.error(`${kept}\n`);
  return session.outcome() === "completed" && !stopped ? 0 : 1;
}
