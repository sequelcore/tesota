import type { ToolCall } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { type Access, type Decision, decide, type Mode, type RuleVerdict, strongest } from "./permission-rule.ts";

/** Rules as an operator or a project writes them (#449): `tool(pattern)`, or a tool's name alone, by verdict. */
export interface RulesFile {
  readonly allow?: readonly string[];
  readonly ask?: readonly string[];
  readonly deny?: readonly string[];
}

export interface Rule {
  readonly tool: string;
  readonly pattern: RegExp | undefined;
  readonly verdict: Exclude<RuleVerdict, "unmatched">;
}

/** The shell tools, which the rule name `shell` stands for whatever the platform's is. */
const shells = new Set(["bash", "powershell"]);

/** A glob as a pattern: `**` any path, `*` anything but a separator for paths and anything at all for commands. */
function globPattern(glob: string, command: boolean): RegExp {
  let source = "";
  for (let k = 0; k < glob.length; k++) {
    const char = glob[k] ?? "";
    if (char === "*" && glob[k + 1] === "*") { source += ".*"; k++; if (glob[k + 1] === "/") k++; }
    else if (char === "*") source += command ? ".*" : "[^/]*";
    else if (char === "?") source += command ? "." : "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, process.platform === "win32" && !command ? "iu" : "u");
}

/** One rule from its text, or undefined when it is not one. */
function parseRule(text: string, verdict: Rule["verdict"]): Rule | undefined {
  const match = /^([\w.-]+)(?:\((.*)\))?$/u.exec(text.trim());
  if (match === null) return undefined;
  const tool = match[1] ?? "";
  const glob = match[2];
  return { tool, verdict, pattern: glob === undefined ? undefined : globPattern(glob, tool === "shell" || shells.has(tool)) };
}

function rulesOf(file: RulesFile, verdicts: readonly Rule["verdict"][]): Rule[] {
  return verdicts.flatMap((verdict) => (file[verdict] ?? []).flatMap((text) => {
    const rule = parseRule(text, verdict);
    return rule === undefined ? [] : [rule];
  }));
}

function readRules(path: string): RulesFile {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} does not hold permission rules.`);
  return parsed as RulesFile;
}

/**
 * The rules for a session in `cwd` (#449): the operator's from
 * `~/.tesota/permissions.json`, and the project's from
 * `.tesota/permissions.json`, of which only `ask` and `deny` count, so a
 * repository can tighten what its operator allows but never grant itself
 * more.
 */
export function loadRules(cwd: string, home: string = tesotaHome()): Rules {
  return [...rulesOf(readRules(join(home, "permissions.json")), ["allow", "ask", "deny"]),
    ...rulesOf(readRules(join(cwd, ".tesota", "permissions.json")), ["ask", "deny"])];
}

/** The same path however it is spelled: absolute, its real name where it exists (Windows' short names, links), and on Windows in one case. */
function canonical(path: string): string {
  let real = resolve(path);
  for (let at = real, rest = ""; ; at = dirname(at)) {
    if (existsSync(at)) {
      try { real = join(realpathSync.native(at), rest); } catch { /* as resolved */ }
      break;
    }
    rest = rest === "" ? basename(at) : join(basename(at), rest);
    if (dirname(at) === at) break;
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}

/** Folders that stay put while a session runs, resolved once: its own, SSH's, and Tesota's credentials. */
const settled = new Map<string, string>();
const canonicalOnce = (path: string): string => {
  let found = settled.get(path);
  if (found === undefined) { found = canonical(path); settled.set(path, found); }
  return found;
};

const inside = (path: string, folder: string): boolean => {
  const from = relative(folder, path);
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
};

/** Commands that destroy what no request asks to destroy: a disk, the root or home folder, the system's. A net, not a guarantee. */
const destructive: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*\s+|--recursive\s+|--force\s+)+(\/|~|\$HOME|\/\*|\.\.?\/?)(\s|$)/u,
  /\bremove-item\b[^\n]*-recurse\b[^\n]*\s(['"]?[a-z]:\\?['"]?|~|\$home|\$env:userprofile|\$env:systemroot)(\s|$)/iu,
  /\bformat(\.com)?\s+[a-z]:/iu,
  /\bmkfs(\.\w+)?\b/u,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/u,
  /\b(rd|rmdir|del)\s+\/[sq][^\n]*\s[a-z]:\\?(\s|$)/iu,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u,
];

/** Secrets no call may touch: Tesota's credentials, SSH's keys, and `.env` files. */
function secretPath(path: string): boolean {
  const name = basename(path);
  return /^\.env(\..+)?$/u.test(name) || inside(path, canonicalOnce(join(homedir(), ".ssh")))
    || path === canonicalOnce(join(tesotaHome(), "auth.json"));
}

/** A command that names a secret: an `.env` file, SSH's folder, or Tesota's credentials. */
const namesSecret = (command: string): boolean =>
  /(^|[\s'"=/\\])\.env(\.[\w.-]+)?($|[\s'"])/u.test(command) || /[\\/]\.ssh([\\/]|\s|$)/u.test(command)
  || /\.tesota[\\/]auth\.json/iu.test(command);

/** What a call is about, for rules and the floor: the path it reads or changes, or the command it runs. */
function subjectOf(call: ToolCall): string {
  const args = call.arguments as Record<string, unknown>;
  const said = args["path"] ?? args["command"];
  return typeof said === "string" ? said : "";
}

/** Why the floor refuses `call`, if it does. */
function floorReason(call: ToolCall, access: Access, cwd: string): string | undefined {
  const subject = subjectOf(call);
  if (shells.has(call.name)) {
    if (destructive.some((pattern) => pattern.test(subject))) return "it would destroy a disk, the root or a home folder";
    if (namesSecret(subject)) return "it names a secret: an .env file, SSH's keys or Tesota's credentials";
    return undefined;
  }
  if (subject === "" || (call.name !== "read" && access === "run")) return undefined;
  const path = canonical(resolve(cwd, subject));
  if (secretPath(path)) return "it is a secret: an .env file, SSH's keys or Tesota's credentials";
  if (access === "write" && !inside(path, canonicalOnce(cwd))) return "it is outside the session's folder";
  return undefined;
}

/** A call's decision and why, as the session records it. */
export interface Verdict {
  readonly decision: Decision;
  readonly by: "floor" | "mode" | "rule";
  readonly reason: string;
}

const modeWords: Readonly<Record<Mode, string>> = { read: "read only", ask: "ask", full: "full access" };

/**
 * Whether `call`, a tool that `access`es, may run in `cwd` (#449): the
 * floor, then the mode and the strongest matching rule, decided by the
 * proved rule (`decide`), with `present` saying whether someone can answer.
 */
export function judge(call: ToolCall, access: Access, cwd: string, mode: Mode, rules: Rules, present: boolean): Verdict {
  const floor = floorReason(call, access, cwd);
  const subject = shells.has(call.name) ? subjectOf(call)
    : subjectOf(call) === "" ? "" : relative(cwd, resolve(cwd, subjectOf(call))).split("\\").join("/");
  const matched = rules.filter((rule) => (rule.tool === call.name || (rule.tool === "shell" && shells.has(call.name)))
    && (rule.pattern === undefined || rule.pattern.test(subject)));
  const rule = strongest(matched.map(({ verdict }) => verdict));
  const decision = decide(floor !== undefined, mode, access, rule, present);
  if (floor !== undefined) return { decision, by: "floor", reason: `Tesota never allows this: ${floor}.` };
  if (rule !== "unmatched") return { decision, by: "rule", reason: `A permission rule says ${rule}.` };
  if (decision === "deny") {
    return { decision, by: "mode", reason: mode === "read" ? "The session is read only." : "No one is here to allow it." };
  }
  return { decision, by: "mode", reason: `The session is in ${modeWords[mode]}.` };
}

/** A session's rules, as `loadRules` reads them. */
export type Rules = readonly Rule[];

export type { Access, Mode };
