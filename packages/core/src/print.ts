import type { MutableModels } from "@earendil-works/pi-ai";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { provideHost } from "../../../src/host.ts";
import { entryReceipt, isReceipt, type Receipt, receiptStanding, standingWords, unverifiedWhy } from "../../../src/receipt.ts";
import tesota from "../../../src/tesota.ts";
import { fileCredentialStore } from "./credentials.ts";
import { branchOf } from "./branch.ts";
import { anyHooks, type Hooks, joinHooks } from "./hooks.ts";
import type { McpServers } from "./mcp.ts";
import { type McpServerConfig, readMcpConfig } from "./mcp-config.ts";
import { unusedModels } from "./agents.ts";
import { accountLabels, engineModels, runnableModel } from "./model-access.ts";
import { loadRules } from "./permissions.ts";
import { askedSessions, createSession, type EngineSession, openSession, type OpenOptions, pendingQuestion, sessionsFolder } from "./session.ts";
import { lastFloorNotice, peekSessionFile, SessionFileError } from "./session-file.ts";
import { SessionLockedError } from "./session-lock.ts";
import { readSettings, type Settings } from "./settings.ts";
import { shellHost } from "./shell/surface.ts";
import { readStandards } from "./standards.ts";

export interface PrintOutput {
  readonly out: (text: string) => void;
  readonly error: (text: string) => void;
}

const usage = "tesota -p [-c | --resume <session>] \"<request>\" [--model <provider>/<id>]";

/** The session `-c` (the folder's latest) or `--resume <id>` names (#651). */
type Named = { readonly latest: true } | { readonly id: string };

/** The value option `names` gives at `args[at]`, as `<name> <value>` or `--<name>=<value>`, and how many arguments it took; none when it is not there. */
function option(args: readonly string[], at: number, names: readonly string[], accepts: (value: string) => boolean):
  { value: string; took: number } | undefined {
  const arg = args[at] ?? "";
  const next = args[at + 1];
  if (names.includes(arg)) return next !== undefined && accepts(next) ? { value: next, took: 2 } : undefined;
  const long = names.find((name) => name.startsWith("--") && arg.startsWith(`${name}=`));
  const value = long === undefined ? undefined : arg.slice(long.length + 1);
  return value !== undefined && accepts(value) ? { value, took: 1 } : undefined;
}

/** The request, model and session `-p`'s arguments name, or what is wrong with them. */
function parse(args: readonly string[]): { request: string; model?: string; session?: Named } | string {
  let request: string | undefined;
  let model: string | undefined;
  let session: Named | undefined;
  for (let at = 0; at < args.length;) {
    const arg = args[at] ?? "";
    const chosen = option(args, at, ["--model"], (value) => value.includes("/"));
    const resumed = option(args, at, ["-r", "--resume"], (value) => value !== "" && !value.startsWith("-"));
    const latest = arg === "-c" || arg === "--continue";
    if ((latest || resumed !== undefined) && session !== undefined) return `-c and --resume each name the session to continue; give one. Use: ${usage}`;
    if (chosen !== undefined) model = chosen.value;
    else if (resumed !== undefined) session = { id: resumed.value };
    else if (latest) session = { latest: true };
    else if (!arg.startsWith("-") && request === undefined) request = arg;
    else return `${arg} is not something tesota -p takes. Use: ${usage}`;
    at += chosen?.took ?? resumed?.took ?? 1;
  }
  if (request === undefined || request.trim() === "") return `Say what to do. Use: ${usage}`;
  return { request, ...model === undefined ? {} : { model }, ...session === undefined ? {} : { session } };
}

/**
 * The file of the session `named` in `cwd`'s folder, among those `/resume`
 * lists (#651): the one changed last for `-c`, the one with that id, as
 * `tesota receipt` and `/resume` show it, for `--resume`; or why there is none.
 */
function sessionNamed(cwd: string, named: Named | undefined): { file?: string } | { refused: string } {
  if (named === undefined) return {};
  const asked = askedSessions(sessionsFolder(cwd)).map(({ file }) => file);
  if ("id" in named) {
    const file = asked.find((each) => basename(each, ".jsonl") === named.id);
    return file === undefined ? { refused: `No session ${named.id} in this folder; tesota receipt and /resume name its sessions.` } : { file };
  }
  const file = asked.map((each) => ({ each, changed: statSync(each).mtimeMs })).sort((a, b) => b.changed - a.changed)[0]?.each;
  return file === undefined ? { refused: "No session in this folder to continue; start one with tesota -p \"<request>\"." } : { file };
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

/** How the run ended and where its verification stands, from the receipt it settled with, and what Tesota's floor refused (#622). */
function ending(outcome: string | undefined, file: string): string {
  const { entries } = peekSessionFile(file);
  const receipt = branchOf(entries).map(entryReceipt).findLast((found) => found !== undefined);
  const standing = isReceipt(receipt) ? receiptStanding(receipt) : undefined;
  // A run that changed nothing claims no standing (#668); one that changed something unverified says why.
  return `${outcome === "completed" ? "Completed" : `Ended ${outcome ?? "without a run"}`}`
    + `${standing === undefined ? "" : standing === "unchanged" ? ` (${standingWords[standing]})`
      : `, ${standingWords[standing]}${standing === "unverified" ? `: ${unverifiedWhy(receipt as Receipt)}` : ""}; tesota receipt writes it for a pull request`}.\n`
    + (lastFloorNotice(entries) ?? "")
    // A run that ended on its question says how to answer it (#651).
    + (pendingQuestion(entries) === undefined ? "" : `Awaiting your answer: tesota -p --resume ${basename(file, ".jsonl")} "<answer>"\n`);
}

/** What the operator's settings choose for a session: its thinking, how many subagents run at once, and their branch guard. */
function chosenOptions(settings: Settings): Pick<OpenOptions, "thinkingLevel" | "agentLimit" | "branchGuard"> {
  return { ...settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel },
    ...settings.agentLimit === undefined ? {} : { agentLimit: settings.agentLimit },
    ...settings.subagentBranchGuard === undefined ? {} : { branchGuard: settings.subagentBranchGuard } };
}

/**
 * A new session in `cwd`, or the one in `file` that -c or --resume named,
 * opened as /resume opens it; none, saying why, when another process holds
 * it, with the lock's message, or it cannot be read.
 */
function sessionFor(cwd: string, file: string | undefined, options: OpenOptions, write: PrintOutput): EngineSession | undefined {
  try {
    return file === undefined ? createSession({ cwd, ...options }) : openSession(file, options);
  } catch (error) {
    if (!(error instanceof SessionLockedError || error instanceof SessionFileError)) throw error;
    write.error(`Not run: ${error.message}\n`);
    return undefined;
  }
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
  flags: Readonly<Record<string, string>> = {}, settingsPath: string = join(tesotaHome(), "settings.json"),
  models?: MutableModels): Promise<number> {
  const asked = parse(args);
  if (typeof asked === "string") { write.error(`${asked}\n`); return 2; }
  const named = sessionNamed(cwd, asked.session);
  if ("refused" in named) { write.error(`${named.refused}\n`); return 1; }
  const { settings } = readSettings(settingsPath);
  const accounts = settings.accounts ?? [];
  models ??= engineModels(fileCredentialStore(), accounts);
  for (const [id, label] of await accountLabels(fileCredentialStore(), accounts)) write.error(`${id}: ${label}\n`);
  const chosen = asked.model ?? settings.model;
  if (chosen === undefined) { write.error("No model: run tesota, then /login and /model.\n"); return 1; }
  // A model the sign-in does not serve is refused here rather than at the first request (#566).
  const runnable = await runnableModel(models, chosen);
  if (typeof runnable === "string") { write.error(`Not run: ${runnable}\n`); return 1; }
  const { model, unchecked } = runnable;
  if (unchecked !== undefined) write.error(`${unchecked}\n`);
  provideHost(shellHost());
  const { hooks, mcp } = trustedStandards(cwd, settingsPath, write);
  const rules = loadRules(cwd);
  let servers: McpServers | undefined;
  const options: OpenOptions = { models, model, verifier: (pi, request) => { tesota(pi, request); },
    mode: "print", flags, hooks: () => hooks, mcp: () => servers,
    permissions: { mode: () => settings.permissionMode ?? "ask", rules }, ...chosenOptions(settings) };
  const session = sessionFor(cwd, named.file, options, write);
  if (session === undefined) return 1;
  const unused = unusedModels(session.types, `${model.provider}/${model.id}`);
  if (unused !== undefined) write.error(`${unused}\n`);
  let stopped = false;
  const stop = (): void => { stopped = true; void session.abort(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    servers = await serversFor(session, mcp);
    // A request stopped before it began is refused rather than run; that is the stop, not a failure to report.
    // In a session that ended on its question the text is the answer; otherwise a follow-up, as the shell sends one (#651).
    await session.reply(asked.request).catch((error: unknown) => { if (!stopped) throw error; });
    write.out(`${session.lastAssistantText() ?? ""}\n`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // Each is let go of whatever the other does, so a session that fails to close never leaves its servers running.
    await Promise.allSettled([session.dispose(), servers?.close()]);
    // A run that throws still says how it ended and what the floor refused (#622).
    write.error(ending(session.outcome(), session.file));
  }
  const kept = session.kept();
  if (kept !== undefined) write.error(`${kept}\n`);
  return session.outcome() === "completed" && !stopped ? 0 : 1;
}
