import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../src/contract.js";
import { provideHost } from "../src/host.js";
import { runProcess } from "../src/process.js";
import tesota from "../src/tesota.js";
import { instructionsText, type Skill, skillCatalog, skillsIn } from "../packages/core/src/instructions.js";
import { engineModels } from "../packages/core/src/model-access.js";
import { createSession } from "../packages/core/src/session.js";
import { shellHost } from "../packages/core/src/shell/surface.js";
import { codingTools } from "../packages/core/src/tools/index.js";
import { sessionFacts } from "./sessions.js";

/**
 * The sessions the evaluation runs (#464), on Tesota's engine instead of Pi.
 * A model `claude-code/<id>` runs through `claude -p` on the operator's Claude
 * sign-in, since the engine has no Claude route; any other runs on the engine
 * from the operator's Tesota sign-in. Each engine session runs in its own
 * process, this file with an options file, so a hung run can be stopped with
 * all it started.
 */

/** How an evaluation session runs. */
export interface SessionRun {
  /** `<provider>/<id>`, or `claude-code/<id>` for Claude. */
  readonly model: string;
  /** The folder it works in; its session files go beside it, in `sessions`. */
  readonly directory: string;
  /** The tools it may use: none when empty, the engine's coding tools when not given. */
  readonly tools?: readonly string[];
  readonly prompt: string;
  /** Whether Tesota verifies the run, as `tesota -p` does; without it the run settles at once, the baseline. */
  readonly verify?: boolean;
  /** Skill folders: each a skill, with its SKILL.md, or a folder of skills. The engine's only. */
  readonly skills?: readonly string[];
  /** The engine's reasoning effort: Pi's default, `medium`, when not given. */
  readonly thinking?: ModelThinkingLevel;
  /** Prepended to the session's `PATH`. */
  readonly path?: string;
  readonly timeoutMs?: number;
}

/** How a session ended, what it answered and what it cost. */
export interface SessionResult {
  readonly ended: string;
  readonly exitCode: number | null;
  /** The last thing the model said; the process's own output when it said nothing. */
  readonly output: string;
  readonly durationMs: number;
  readonly modelRequests: unknown;
  readonly tokens: unknown;
  /** The engine session's facts (`sessionFacts`); none for Claude. */
  readonly facts?: Record<string, unknown>;
}

const claudePrefix = "claude-code/";

export async function session(run: SessionRun): Promise<SessionResult> {
  if (!run.model.startsWith(claudePrefix)) return engine(run);
  // Claude Code is never verified by Tesota and loads no skills here, so a run that asks for either would be mislabeled.
  if (run.verify === true || (run.skills ?? []).length > 0) throw new Error(`${run.model} runs only without Tesota and without skills.`);
  return claude(run);
}

/** Model access the way verifiers get it, for a measurement that calls a model directly. */
export async function engineRegistry(): Promise<ModelRegistry> {
  const models = await engineModels();
  return { find: (provider, id) => models.getModel(provider, id), complete: (model, context, options) => models.complete(model, context, options) };
}

/** The options file `engine` hands its process. */
interface EngineOptions {
  readonly model: string;
  readonly directory: string;
  readonly sessions: string;
  readonly tools?: readonly string[];
  readonly prompt: string;
  readonly reply: string;
  readonly verify: boolean;
  readonly skills: readonly string[];
  readonly thinking: ModelThinkingLevel;
  readonly timeoutMs: number;
}

async function engine(run: SessionRun): Promise<SessionResult> {
  const root = dirname(run.directory);
  const sessions = join(root, "sessions");
  const options: EngineOptions = { model: run.model, directory: run.directory, sessions, ...run.tools === undefined ? {} : { tools: run.tools },
    prompt: join(root, "prompt.md"), reply: join(root, "reply.md"), verify: run.verify ?? false, skills: run.skills ?? [],
    thinking: run.thinking ?? "medium", timeoutMs: run.timeoutMs ?? 30 * 60_000 };
  writeFileSync(options.prompt, run.prompt);
  const file = join(root, "session.json");
  writeFileSync(file, JSON.stringify(options));
  const env = run.path === undefined ? undefined : { ...process.env, PATH: [run.path, process.env["PATH"]].join(process.platform === "win32" ? ";" : ":") };
  const started = Date.now();
  const ended = await runProcess(process.execPath, [fileURLToPath(import.meta.url), file], run.directory, new AbortController().signal,
    options.timeoutMs + stopGraceMs, undefined, env === undefined ? {} : { env });
  const facts = sessionFacts(sessions);
  return { ended: ended.ended, exitCode: ended.exitCode, output: existsSync(options.reply) ? readFileSync(options.reply, "utf8") : ended.output,
    durationMs: Date.now() - started, modelRequests: facts["modelRequests"], tokens: facts["tokens"], facts };
}

/**
 * How long a session stopped at its time limit has to let go of the commands it started before its process is killed:
 * killed first, commands that run in groups of their own outlive it outside Windows' job.
 */
const stopGraceMs = 60_000;

/** The skills each folder names: the folder itself when it holds a SKILL.md, else the skills inside it. */
function skillsOf(folder: string): Skill[] {
  const own = join(folder, "SKILL.md");
  // Compared as the file system names them, so a path spelled in other letter case on Windows still finds its skill.
  return existsSync(own) ? skillsIn(dirname(folder)).filter((skill) => realpathSync.native(skill.path) === realpathSync.native(own))
    : skillsIn(folder);
}

/** One engine session, in this process, from `engine`'s options file: it writes the model's last answer and exits 0 when it completed. */
async function engineProcess(file: string): Promise<number> {
  const options = JSON.parse(readFileSync(file, "utf8")) as EngineOptions;
  const models = await engineModels();
  const [provider = "", ...id] = options.model.split("/");
  const model = models.getModel(provider, id.join("/"));
  if (model === undefined) throw new Error(`No model ${options.model} on the engine: sign in with tesota, then /login.`);
  provideHost(shellHost());
  const catalog = skillCatalog(options.skills.flatMap(skillsOf), model.contextWindow);
  const session = createSession({ cwd: options.directory, folder: options.sessions, models, model, mode: "print",
    thinkingLevel: options.thinking, instructions: instructionsText([], catalog),
    ...options.tools === undefined ? {} : { tools: (spool: () => string) => codingTools(options.directory, spool)
      .filter((tool) => options.tools?.includes(tool.name)) },
    verifier: options.verify ? (pi, request) => { tesota(pi, request); } : (pi) => { pi.on("agent_before_settle", () => undefined); } });
  try {
    // Stopped at its time limit here, so the session lets go of what it started before `engine` kills this process.
    const limit = setTimeout(() => { void session.abort(); }, options.timeoutMs);
    await session.prompt(readFileSync(options.prompt, "utf8")).finally(() => { clearTimeout(limit); });
    writeFileSync(options.reply, session.lastAssistantText() ?? "");
  } finally {
    await session.dispose();
  }
  return session.outcome() === "completed" ? 0 : 1;
}

/** The tools Claude Code has for the engine's: none when empty, a coding agent's when not given. */
const claudeTools: Readonly<Record<string, string>> = { read: "Read", grep: "Grep", find: "Glob", ls: "Glob", write: "Write", edit: "Edit",
  bash: "Bash" };

/**
 * A `claude -p` session: no settings, instructions, skills or MCP servers of
 * the operator's, and no session kept. One that can write or run commands
 * does so without asking, as an engine session in print mode would.
 */
async function claude(run: SessionRun): Promise<SessionResult> {
  const tools = [...new Set((run.tools ?? ["read", "grep", "find", "edit", "write", "bash"]).map((name) => {
    const named = claudeTools[name];
    if (named === undefined) throw new Error(`Claude Code has no tool for ${name}.`);
    return named;
  }))];
  const acts = tools.some((name) => name === "Write" || name === "Edit" || name === "Bash");
  const started = Date.now();
  const ran = await capture("claude", ["-p", "--model", run.model.slice(claudePrefix.length), "--output-format", "json", "--tools", tools.join(","),
    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ...acts ? ["--permission-mode", "bypassPermissions"] : []], run.directory, run.timeoutMs ?? 30 * 60_000, run.prompt);
  let result: Record<string, any> = {};
  try { result = JSON.parse(ran.stdout) as Record<string, any>; } catch { /* reported as its output */ }
  const usage = result["usage"] ?? {};
  return { ended: ran.ended, exitCode: ran.code,
    output: typeof result["result"] === "string" ? result["result"] : `${ran.stdout}\n${ran.stderr}`.slice(-8000),
    durationMs: Date.now() - started, modelRequests: result["num_turns"],
    tokens: { input: usage["input_tokens"], output: usage["output_tokens"], cacheRead: usage["cache_read_input_tokens"],
      total: ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .reduce((total, name) => total + Number(usage[name] ?? 0), 0), costUsd: result["total_cost_usd"] } };
}

/**
 * A command's whole stdout, the end of its errors, how it ended and its
 * exit code, null when it did not exit: at `timeoutMs`, `runProcess` stops
 * it and everything it started.
 */
export async function capture(command: string, args: readonly string[], cwd: string, timeoutMs: number, input?: string):
  Promise<{ readonly ended: string; readonly stdout: string; readonly stderr: string; readonly code: number | null }> {
  const chunks: Buffer[] = [];
  const ran = await runProcess(command, args, cwd, new AbortController().signal, timeoutMs, undefined,
    { onStdout: (chunk) => { chunks.push(chunk); }, ...input === undefined ? {} : { input } });
  return { ended: ran.ended, stdout: Buffer.concat(chunks).toString("utf8"), stderr: ran.ended === "exited" ? ran.stderr : `${ran.ended}: ${ran.output}`,
    code: ran.ended === "exited" ? ran.exitCode : null };
}

if (import.meta.main) {
  engineProcess(process.argv[2] ?? "").then((code) => { process.exit(code); }, (error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
