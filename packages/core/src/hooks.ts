import { existsSync, readFileSync } from "node:fs";
import { runProcess } from "../../../src/process.ts";

/**
 * Command hooks (#457), configured as Claude Code configures them, which
 * Codex follows too: under `hooks` in a settings file, each event a list of
 * groups, each group a `matcher` of tool names and the commands it runs.
 */
export type HookEvent = "PreToolUse" | "PostToolUse";

export interface HookCommand {
  readonly type: "command";
  readonly command: string;
  /** Seconds before the hook is stopped; 600 when not given, as Codex and Claude Code wait. */
  readonly timeout?: number;
}

export interface HookGroup {
  /** The tool names it runs for: a name, names joined by `|`, a pattern, or every tool when empty, `*` or absent. */
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

export type Hooks = Readonly<Partial<Record<HookEvent, readonly HookGroup[]>>>;

const events: readonly HookEvent[] = ["PreToolUse", "PostToolUse"];
const defaultTimeoutSeconds = 600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The hooks in the settings file at `path`; none when it has none or does not
 * exist. Hooks it holds in a shape Tesota cannot read are an error naming
 * the file, since a guard left out would protect nothing.
 */
export function readHooks(path: string): Hooks {
  if (!existsSync(path)) return {};
  let settings: unknown;
  try { settings = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const hooks = isRecord(settings) ? settings["hooks"] : undefined;
  if (hooks === undefined) return {};
  if (!isRecord(hooks)) throw new Error(`${path}: hooks must be an object of events.`);
  const read: Partial<Record<HookEvent, HookGroup[]>> = {};
  for (const event of events) {
    const groups = hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) throw new Error(`${path}: hooks.${event} must be a list of groups.`);
    read[event] = groups.map((group, index): HookGroup => {
      const at = `${path}: hooks.${event}[${index}]`;
      if (!isRecord(group) || !Array.isArray(group["hooks"])) throw new Error(`${at} must have a list of hooks.`);
      const matcher = group["matcher"];
      if (matcher !== undefined && typeof matcher !== "string") throw new Error(`${at}.matcher must be text.`);
      const commands = group["hooks"].map((hook, place): HookCommand => {
        if (!isRecord(hook) || hook["type"] !== "command" || typeof hook["command"] !== "string") {
          throw new Error(`${at}.hooks[${place}] must be a command hook: { "type": "command", "command": "…" }.`);
        }
        const timeout = hook["timeout"];
        if (timeout !== undefined && (typeof timeout !== "number" || !(timeout > 0))) throw new Error(`${at}.hooks[${place}].timeout must be seconds.`);
        return { type: "command", command: hook["command"], ...timeout === undefined ? {} : { timeout } };
      });
      return { ...matcher === undefined ? {} : { matcher }, hooks: commands };
    });
  }
  return read;
}

/** The hooks of several files together, in the order given. */
export function joinHooks(...all: readonly Hooks[]): Hooks {
  const joined: Partial<Record<HookEvent, HookGroup[]>> = {};
  for (const hooks of all) {
    for (const event of events) {
      const groups = hooks[event];
      if (groups !== undefined && groups.length > 0) joined[event] = [...joined[event] ?? [], ...groups];
    }
  }
  return joined;
}

/** Whether `hooks` runs anything at all. */
export const anyHooks = (hooks: Hooks): boolean => events.some((event) => (hooks[event]?.length ?? 0) > 0);

/** Whether a group's matcher takes `tool`, as Claude Code reads one: empty or `*` for every tool, else a whole-name pattern. */
function matches(matcher: string | undefined, tool: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  try { return new RegExp(`^(?:${matcher})$`, "u").test(tool); } catch { return matcher === tool; }
}

/** What a hook's call is about, as `hookio.py` and Claude Code's hooks read it. */
export interface HookInput {
  readonly session_id: string;
  readonly cwd: string;
  readonly hook_event_name: HookEvent;
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_response?: unknown;
}

/** What the matching hooks decided: a reason when any blocked, and the notes they left for the operator. */
export interface HookOutcome {
  readonly blocked?: string;
  readonly notes: readonly string[];
}

interface Ran {
  readonly blocked?: string;
  readonly note?: string;
}

/**
 * A shell for a hook's command line: `sh`, or Windows' own given the line
 * as written, as Node's `shell: true` gives it, since `cmd.exe` does not read
 * the escaped quotes a quoted path would otherwise arrive with.
 */
const shellFor = (command: string): string[] => process.platform === "win32"
  ? [process.env["ComSpec"] ?? "cmd.exe", "/d", "/s", "/c", `"${command}"`] : ["sh", "-c", command];

/**
 * One hook: its command given `input` as JSON on its standard input, in
 * `cwd`. Exit 2 blocks with its error output as the reason; on exit 0 its
 * JSON output may block (`decision: "block"`, or a `deny` permission
 * decision) and leave a `systemMessage`. A hook that fails, times out or
 * cannot start lets the call through, with a note, as Codex, Claude Code and
 * Gemini CLI let it.
 */
async function runHook(hook: HookCommand, input: HookInput, signal: AbortSignal): Promise<Ran> {
  const seconds = hook.timeout ?? defaultTimeoutSeconds;
  const [shell, ...args] = shellFor(hook.command);
  // Tesota's one process runner (#457): a hook that runs past its time is stopped with every process it started, and
  // what it prints is kept within bounds.
  const run = await runProcess(shell ?? "sh", args, input.cwd, signal, seconds * 1000, undefined,
    { input: JSON.stringify(input), env: { ...process.env, TESOTA_PROJECT_DIR: input.cwd }, verbatim: true });
  if (run.ended === "cancelled") return {};
  if (run.ended === "not_started") return { note: `Hook "${hook.command}" could not start: ${run.output}.` };
  if (run.ended === "timed_out") return { note: `Hook "${hook.command}" ran past ${seconds} s and was stopped; the call went on.` };
  const err = run.stderr.trim();
  if (run.exitCode === 2) return { blocked: err || `Hook "${hook.command}" blocked it.` };
  if (run.exitCode !== 0) return { note: `Hook "${hook.command}" failed (exit ${run.exitCode ?? "none"})${err === "" ? "" : `: ${err}`}; the call went on.` };
  return decided(hook, run.stdout.trim());
}

/** What a hook that exited 0 decided by its JSON output: a block, a note, both, or nothing when it wrote no JSON. */
function decided(hook: HookCommand, text: string): Ran {
  if (!text.startsWith("{")) return {};
  let said: unknown;
  try { said = JSON.parse(text); } catch {
    return { note: `Hook "${hook.command}" wrote output that is not JSON; the call went on.` };
  }
  if (!isRecord(said)) return {};
  const specific = isRecord(said["hookSpecificOutput"]) ? said["hookSpecificOutput"] : {};
  const reason = typeof said["reason"] === "string" ? said["reason"]
    : typeof specific["permissionDecisionReason"] === "string" ? specific["permissionDecisionReason"] : undefined;
  const note = typeof said["systemMessage"] === "string" && said["systemMessage"].trim() !== "" ? said["systemMessage"] : undefined;
  const blocks = said["decision"] === "block" || specific["permissionDecision"] === "deny";
  return { ...blocks ? { blocked: reason ?? `Hook "${hook.command}" blocked it.` } : {}, ...note === undefined ? {} : { note } };
}

/**
 * Runs the hooks of `input`'s event whose matcher takes its tool, all at
 * once; any that blocks blocks the call, whatever the others said, and every
 * note is kept.
 */
export async function runHooks(hooks: Hooks, input: HookInput, signal: AbortSignal = new AbortController().signal): Promise<HookOutcome> {
  const matching = (hooks[input.hook_event_name] ?? []).filter((group) => matches(group.matcher, input.tool_name))
    .flatMap((group) => group.hooks);
  // A stopped run starts no hook: one would only hold the stop up.
  if (matching.length === 0 || signal.aborted) return { notes: [] };
  const ran = await Promise.all(matching.map((hook) => runHook(hook, input, signal)));
  const blocked = ran.flatMap((each) => each.blocked === undefined ? [] : [each.blocked]);
  return { ...blocked.length === 0 ? {} : { blocked: blocked.join("\n") },
    notes: ran.flatMap((each) => each.note === undefined ? [] : [each.note]) };
}
