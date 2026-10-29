import type { ToolCall } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { parseJson } from "../../../src/json.ts";
import { type Access, type Decision, decide, isDataCommand, type Mode, type RuleVerdict, strongest, within, writable } from "./permission-rule.ts";
import { climbsBack, normalizeWindowsSegment } from "./subpath-rule.ts";
import type { FloorRefusal } from "../../../src/receipt.ts";

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

/**
 * A glob as a pattern: `**` any path, `**` before a slash any folders or none, `*` anything
 * but a separator for paths and anything at all for commands. On Windows,
 * paths match in any case, as Windows reads them; commands do only for deny
 * and ask rules, since a program's flags keep their case (`-d` is not `-D`).
 */
function globPattern(glob: string, command: boolean, verdict: Rule["verdict"]): RegExp {
  let source = "";
  for (let k = 0; k < glob.length; k++) {
    const char = glob[k] ?? "";
    if (char === "*" && glob[k + 1] === "*" && glob[k + 2] === "/") { source += "(?:.*/)?"; k += 2; }
    else if (char === "*" && glob[k + 1] === "*") { source += ".*"; k++; }
    else if (char === "*") source += command ? ".*" : "[^/]*";
    else if (char === "?") source += command ? "." : "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  const anyCase = process.platform === "win32" && (!command || verdict !== "allow");
  return new RegExp(`^${source}$`, `${anyCase ? "i" : ""}su`);
}

/**
 * A command's parts, split where a shell may run one command after another or
 * inside another: line breaks, `;`, `&`, `|`, backticks and parentheses, in
 * any run. Quotes are not read, so a part may split where the shell would not;
 * deny and ask rules also read the whole command, so that only makes allow
 * rules match less.
 */
const commandParts = (command: string): string[] =>
  command.split(/[\r\n;&|`()]+/u).map((part) => part.trim()).filter((part) => part !== "");

/** A command that runs another inside it, `$(...)`, backticks or `<(...)`: no allow rule names what that runs. */
const nestsCommands = (command: string): boolean => /\$\(|`|[<>]\(/u.test(command);

/** One rule from its text; a text that is not one is an error, since a rule left out could be a deny. */
function parseRule(text: string, verdict: Rule["verdict"], path: string): Rule {
  const match = /^([\w.-]+)(?:\((.*)\))?$/su.exec(text.trim());
  if (match === null) throw new Error(`${path}: "${text}" is not a rule; write tool(pattern) or a tool's name.`);
  const tool = match[1] ?? "";
  const glob = match[2];
  return { tool, verdict,
    pattern: glob === undefined ? undefined : globPattern(glob, tool === "shell" || shells.has(tool), verdict) };
}

/** The rules in the file at `path`, of the verdicts it may set; none when there is no file. */
function rulesAt(path: string, verdicts: readonly Rule["verdict"][]): Rule[] {
  if (!existsSync(path)) return [];
  let file: unknown;
  try { file = parseJson(readFileSync(path, "utf8")); } catch (error) {
    throw new Error(`${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof file !== "object" || file === null || Array.isArray(file)) throw new Error(`${path} does not hold permission rules.`);
  const said = file as Record<string, unknown>;
  return verdicts.flatMap((verdict) => {
    const texts = said[verdict] ?? [];
    if (!Array.isArray(texts) || !texts.every((text) => typeof text === "string")) {
      throw new Error(`${path}: ${verdict} must be a list of rules.`);
    }
    return texts.map((text) => parseRule(text, verdict, path));
  });
}

/**
 * The rules for a session in `cwd` (#449): the operator's from
 * `~/.tesota/permissions.json`, and the project's from
 * `.tesota/permissions.json`, of which only `ask` and `deny` count, so a
 * repository can tighten what its operator allows but never grant itself
 * more.
 */
export function loadRules(cwd: string, home: string = tesotaHome()): Rules {
  return [...rulesAt(join(home, "permissions.json"), ["allow", "ask", "deny"]),
    ...rulesAt(join(cwd, ".tesota", "permissions.json"), ["ask", "deny"])];
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

/** A canonical path as its names from the root: on Windows split at either slash, elsewhere only at `/`, where `\` is part of a name. */
const names = (path: string): string[] => path.split(process.platform === "win32" ? /[\\/]/u : /\//u).filter((name) => name !== "");

const inside = (path: string, folder: string): boolean => within(names(path), names(folder));

/** Commands that destroy what no request asks to destroy: a disk, the root or home folder, the system's. A net, not a guarantee. */
const destructive: readonly RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*\s+|--recursive\s+|--force\s+)+(\/\*|\.\.?\/?)(?=\s|$|[;&|)])/u,
  /\bformat(\.com)?\s+[a-z]:/iu,
  /\bmkfs(\.\w+)?\b/u,
  /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/u,
  /\b(rd|rmdir|del)\s+\/[sq][^\n]*\s[a-z]:[\\/]?(\s|$)/iu,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u,
];

/** What `rm` deletes, to the end of its command, and `Remove-Item`, to the end of its line, when it recurses. */
const rmWords = /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+|-[a-zA-Z]*f[a-zA-Z]*\s+|--recursive\s+|--force\s+)+([^\n;&|]*)/gu;
const removeItemWords = /\bremove-item\b([^\n]*)/giu;

/** Folders no destructive command may name, nor a subpath that climbs back to them: a drive or the root, home, the system's. */
const guarded = String.raw`[a-z]:|[\\/]|~|\$(?:home|\{home\}|env:userprofile|env:systemroot)`;
/**
 * A word that starts with a guarded folder, and the subpath said after it, read through its quotes:
 * `"$HOME"/..`, `"$HOME/.."` and `$HOME'/..'` are all `$HOME/..`.
 */
const guardedWord = new RegExp(
  String.raw`(?<!\S)(?:"(?:${guarded})([^"\n]*)"|'(?:${guarded})([^'\n]*)'|(?:${guarded}))((?:"[^"\n]*"|'[^'\n]*'|[^\s;&|()'"])*)`,
  "giu",
);

/**
 * Only the flat, parent-first two-argument spelling: `(Join-Path $HOME 'sub')`,
 * optionally with `-Path` and `-ChildPath`. Dynamic children and globs stay visible to the net.
 * This is not parameter binding or evaluation of PowerShell expressions.
 */
const joinPath = /\(\s*join-path\s+(?:-path\s+)?("[^"\n()]*"|'[^'\n()]*'|[^\s()'";|&]+)\s+(?:-childpath\s+)?("[^"\n()]*"|'[^'\n()]*'|[^\s()'";|&]+)\s*\)/giu;

/** Whether a recursive deletion names a guarded folder, or a subpath of one that climbs back to it or above it (#633). */
function deletesGuarded(command: string): boolean {
  const flat = command.replace(joinPath, (group: string, parent: string, child: string) =>
    /[$@`*?[\]]/u.test(child) ? group : ` "${parent.replace(/["']/gu, "")}/${child.replace(/["']/gu, "")}" `);
  // A remaining Join-Path may enclose a group we just flattened. Do not grant
  // any exemption in that case, even for a guarded word with a written subpath:
  // the unjoined arguments could climb out of it. This deliberately fails closed.
  const unjoined = /\bjoin-path\b/iu.test(flat);
  const targets = unjoined ? command : flat;
  const words = [...[...targets.matchAll(rmWords)].map((found) => found[1]!),
    ...[...targets.matchAll(removeItemWords)].map((found) => found[1]!).filter((said) => /-recurse\b/iu.test(said))];
  return words.some((said) => [...said.matchAll(guardedWord)].some(([, doubled, single, rest]) =>
    unjoined || climbsBack(((doubled ?? single ?? "") + rest!.replace(/["']/gu, "")).split(/[\\/]/u).map(normalizeWindowsSegment))));
}

/**
 * Quoted arguments of simple data commands are not commands (#681). Recognize
 * the whole input before hiding anything: unknown syntax or a pipeline consumer
 * could execute the data. This is deliberately not a general shell parser.
 * Escapes, interpolation, redirection, comments and grouping fall back to the
 * original net, as do rg's options that run another program.
 */
function destructiveSubject(command: string): string {
  // PowerShell also treats typographic quotes as delimiters, including when
  // paired with ASCII quotes. Never mask across an unrecognized delimiter.
  if (/[\u2018-\u201f]/u.test(command)) return command;
  const tokens = command.match(/'[^'\r\n]*'|"[^"$`\\\r\n]*"|[^\s'"$`\\;&|(){}<>#]+|[ \t]+|&&|\|\||[;|\r\n]/gu) ?? [];
  if (tokens.join("") !== command) return command;
  let head = true;
  let separated = true;
  const visible: string[] = [];
  for (const token of tokens) {
    if (/^[ \t]+$/u.test(token)) { separated = true; visible.push(token); continue; }
    if (/^(?:&&|\|\||[;|\r\n])$/u.test(token)) {
      if (head) return command;
      head = true;
      separated = true;
      visible.push(token);
      continue;
    }
    if (!separated) return command; // No concatenated or doubled quotes.
    if (head) {
      if (!isDataCommand(token.toLowerCase())) return command;
      head = false;
      visible.push(token);
    } else {
      const quoted = /^["']/u.test(token);
      const argument = quoted ? token.slice(1, -1) : token;
      if (/^--(?:pre|hostname-bin)(?:=|$)/u.test(argument)) return command;
      visible.push(quoted ? "__quoted_data__" : token);
    }
    separated = false;
  }
  return head ? command : visible.join("");
}

/** Secrets no call may touch: Tesota's credentials and its MCP sign-ins (#459), SSH's keys, and `.env` files, by any of the names given. */
function secretPath(...paths: readonly string[]): boolean {
  const ssh = canonicalOnce(join(homedir(), ".ssh"));
  const credentials = ["auth.json", "mcp-auth.json"].flatMap((name) => {
    const file = canonicalOnce(join(tesotaHome(), name));
    return [file, `${file}.new`];
  });
  return paths.some((path) => /^\.env(\..+)?$/iu.test(basename(path)) || inside(path, ssh) || credentials.includes(path));
}

/** A command that names a secret: an `.env` file, SSH's folder, or Tesota's credentials. */
const namesSecret = (command: string): boolean =>
  /(^|[\s'"=/\\])\.env(\.[\w.-]+)?($|[\s'"])/iu.test(command) || /[\\/]\.ssh([\\/]|\s|$)/u.test(command)
  || /\.tesota[\\/](mcp-)?auth\.json/iu.test(command);

/** What a call is about, for rules and the floor: the command a shell runs, or the path another tool reads or changes. */
function subjectOf(call: ToolCall): string {
  // The model's arguments, unvalidated until the call runs: they may be null (#664).
  const said = ((call.arguments ?? {}) as Record<string, unknown>)[shells.has(call.name) ? "command" : "path"];
  return typeof said === "string" ? said : "";
}

/** Why the floor refuses `call`, if it does; a file tool writes only in `cwd` and the session's `scratch` folder (#653). */
function floorReason(call: ToolCall, access: Access, cwd: string, scratch: string | undefined): string | undefined {
  const subject = subjectOf(call);
  if (shells.has(call.name)) {
    const destructiveText = destructiveSubject(subject);
    if (destructive.some((pattern) => pattern.test(destructiveText)) || deletesGuarded(destructiveText)) return "it would destroy a disk, the root or a home folder";
    if (namesSecret(subject)) return "it names a secret: an .env file, SSH's keys or Tesota's credentials";
    return undefined;
  }
  if (subject === "" || (call.name !== "read" && access === "run")) return undefined;
  const asked = resolve(cwd, subject);
  const path = canonical(asked);
  if (secretPath(process.platform === "win32" ? asked.toLowerCase() : asked, path)) return "it is a secret: an .env file, SSH's keys or Tesota's credentials";
  if (access === "write") {
    const folder = names(canonicalOnce(cwd));
    // The scratch folder as the session named it, by its real name, never resolved again: a link put in its place leads outside it.
    const own = scratch === undefined ? folder : names(process.platform === "win32" ? scratch.toLowerCase() : scratch);
    if (!writable(names(path), folder, own)) {
      return `it is outside the session's folder${scratch === undefined ? "" : `. Write temporary files in the session's scratch folder, ${scratch}`}`;
    }
  }
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
 * proved rule (`decide`), with `present` saying whether someone can answer,
 * and `scratch` the session's scratch folder by its real name, when it has one (#653).
 */
export function judge(call: ToolCall, access: Access, cwd: string, mode: Mode, rules: Rules, present: boolean,
  scratch?: string): Verdict {
  const floor = floorReason(call, access, cwd, scratch);
  const shell = shells.has(call.name);
  const subject = shell || subjectOf(call) === "" ? subjectOf(call) : relative(cwd, resolve(cwd, subjectOf(call))).split("\\").join("/");
  // When in doubt, deny and ask rules match more and allow rules less: a deny or ask rule that names the whole
  // command or any part of it counts, and an allow rule allows a command only when every part is allowed and none
  // runs another inside it, so `git status && rm -rf x` and `git status $(rm -rf x)` are asked about.
  const parts = shell ? commandParts(subject) : [subject];
  const own = rules.filter((rule) => rule.tool === call.name || (rule.tool === "shell" && shell));
  const names = (rule: Rule, part: string): boolean => rule.pattern === undefined || rule.pattern.test(part);
  const verdicts = own.filter((rule) => rule.verdict !== "allow" && [subject, ...parts].some((part) => names(rule, part)))
    .map(({ verdict }) => verdict);
  const allows = own.filter((rule) => rule.verdict === "allow");
  if (parts.length > 0 && !(shell && nestsCommands(subject))
    && parts.every((part) => allows.some((rule) => names(rule, part)))) verdicts.push("allow");
  const rule = strongest(verdicts);
  const decision = decide(floor !== undefined, mode, access, rule, present);
  if (floor !== undefined) return { decision, by: "floor", reason: `Tesota never allows this: ${floor}.` };
  if (mode === "read" && access !== "read") return { decision, by: "mode", reason: "The session is read only." };
  if (rule !== "unmatched") return { decision, by: "rule", reason: `A permission rule says ${rule}.` };
  if (decision === "deny") {
    return { decision, by: "mode", reason: mode === "read" ? "The session is read only." : "No one is here to allow it." };
  }
  return { decision, by: "mode", reason: `The session is in ${modeWords[mode]}.` };
}

/** A session's rules, as `loadRules` reads them. */
export type Rules = readonly Rule[];

export type { Access, Mode };

/**
 * What the operator sees at a request's end when Tesota's floor refused
 * calls in it (#622), its own and its subagents', whatever else happened:
 * each refused call, and that the refusals say nothing of what ran after.
 * Undefined when there were none.
 */
export function floorNotice(refusals: readonly FloorRefusal[], children: number): string | undefined {
  if (refusals.length === 0 && children === 0) return undefined;
  const calls = (count: number): string => `${count} call${count === 1 ? "" : "s"}`;
  const lines = refusals.map(({ tool, subject, reason }) =>
    `  ${tool}${subject === "" ? "" : ` ${subject}`}: ${reason.replace(/^Tesota never allows this: /u, "")}`);
  if (children > 0) lines.push(`  its subagents: ${calls(children)}, listed in their own sessions`);
  const count = refusals.length + children;
  return `Tesota's floor refused ${calls(count)}; that shows ${count === 1 ? "it" : "they"} didn't run, not what ran instead:\n`
    + `${lines.join("\n")}\n`;
}
