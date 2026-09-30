import { beginsWith, runsWithoutAsking, savableRule } from "./verification/command-rule.js";

/**
 * Rules for commands on this computer (decision 049): the leading words of a
 * command the operator allowed for a repository, such as `gh pr`, so later
 * commands beginning with them run without asking. A command is read only in
 * a plain form: words, single-quoted or double-quoted without expansions,
 * joined by `&&`, `||`, `;` or `|`. Anything else (redirection, `$`,
 * backquotes, globs, `~`, a leading `VAR=value`, a lone `&`, a newline, a
 * backslash) cannot be read safely, so such a command always asks, as Codex
 * evaluates its rules only on commands without them.
 */

/** A saved rule: a command's leading words. */
export type CommandRule = readonly string[];

/**
 * Programs that run whatever they are given or delete, which a rule can never
 * start with: shells, interpreters, package runners, wrappers that run another
 * command, remote shells, and deleting commands.
 */
export const FORBIDDEN_RULE_PROGRAMS: readonly string[] = Object.freeze([
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "pwsh", "powershell", "cmd", "wsl",
  "python", "py", "node", "deno", "bun", "ruby", "perl", "php", "lua", "java", "osascript",
  "npx", "bunx", "pnpx", "uvx", "pipx",
  "env", "sudo", "doas", "su", "xargs", "exec", "eval", "nohup", "timeout", "time", "nice", "watch", "ssh",
  "rm", "rmdir", "del", "erase", "shred", "unlink", "find",
]);

const SEPARATORS = ["&&", "||", ";", "|"] as const;
/** Characters a word may hold without quotes. */
const PLAIN = /[A-Za-z0-9_@%+=:,./-]/u;
/** Characters a double-quoted word may not hold, since the shell expands them. */
const EXPANDING = /[$`\\!"]/u;

/** A command read as plain parts, or `undefined` when it has anything else. */
export function commandParts(command: string): string[][] | undefined {
  const parts: string[][] = [[]];
  let word: string | undefined;
  const end = (): void => {
    if (word !== undefined) parts.at(-1)?.push(word);
    word = undefined;
  };
  let index = 0;
  while (index < command.length) {
    const character = command[index] ?? "";
    const separator = SEPARATORS.find((candidate) => command.startsWith(candidate, index));
    if (character === " " || character === "\t") { end(); index += 1; continue; }
    if (separator !== undefined) {
      end();
      if (parts.at(-1)?.length === 0) return undefined;
      parts.push([]);
      index += separator.length;
      continue;
    }
    if (character === "'" || character === "\"") {
      const close = command.indexOf(character, index + 1);
      if (close === -1) return undefined;
      const quoted = command.slice(index + 1, close);
      if (character === "\"" && EXPANDING.test(quoted) || quoted.includes("\n")) return undefined;
      word = `${word ?? ""}${quoted}`;
      index = close + 1;
      continue;
    }
    if (!PLAIN.test(character)) return undefined;
    word = `${word ?? ""}${character}`;
    index += 1;
  }
  end();
  // An empty part, as after a trailing separator, and an assignment in place of a program are not plain.
  if (parts.some((part) => part.length === 0 || (part[0] ?? "").includes("="))) return undefined;
  return parts;
}

/** A program's name as a rule compares it: no folder, no extension, no version, lower case, as `python3.12.exe` is `python`. */
export function programName(word: string): string {
  const name = word.split(/[\\/]/u).at(-1) ?? word;
  return name.toLowerCase().replace(/\.(?:exe|cmd|bat|com|ps1)$/u, "").replace(/[\d.]+$/u, "");
}

/** Whether the operator may save this rule (proved: `savableRule`). */
export function canSaveRule(rule: CommandRule): boolean {
  const [program, ...rest] = rule;
  if (program === undefined || rule.some((word) => word.length === 0)) return false;
  return savableRule([programName(program), ...rest], [...FORBIDDEN_RULE_PROGRAMS]);
}

/** Whether saved rules let this command run on this computer without asking (proved: `runsWithoutAsking`). */
export function allowedByRules(command: string, rules: readonly CommandRule[]): boolean {
  const parts = commandParts(command);
  return runsWithoutAsking(parts !== undefined, parts ?? [], rules.map((rule) => [...rule]));
}

/** Words a rule may be built from: a name or subcommand, never a flag, a path or an assignment. */
const RULE_WORD = /^[A-Za-z0-9][A-Za-z0-9_:@+-]*$/u;
const SUGGESTED_WORDS = 3;

/**
 * The rule to offer for a command: the agent's suggestion when it begins the
 * command's first part and may be saved, otherwise the first part's leading
 * names, up to three, before any flag or path. None when the command is not
 * plain or no rule may be saved.
 */
export function offeredRule(command: string, suggested?: CommandRule): CommandRule | undefined {
  const [first] = commandParts(command) ?? [];
  if (first === undefined) return undefined;
  if (suggested !== undefined && beginsWith(first, [...suggested]) && canSaveRule(suggested)) return suggested;
  const names: string[] = [];
  for (const word of first) {
    if (names.length === SUGGESTED_WORDS || !RULE_WORD.test(word)) break;
    names.push(word);
  }
  return canSaveRule(names) ? names : undefined;
}
