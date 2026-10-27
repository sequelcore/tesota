import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { GuardSetting } from "./agent-rule.ts";
import type { Mode } from "./permission-rule.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { withLock } from "./session-lock.ts";
import { parseJson } from "../../../src/json.ts";
import { writeWholeJson } from "./whole-file.ts";

/** How the shell draws: on the alternate screen, or into the terminal's scrollback (#432). */
export type TuiMode = "fullscreen" | "inline";

/** An explicitly chosen provider instance; declared only in the operator's settings. */
export type Account = { readonly name: string; readonly provider: "claude-code"; readonly folder: string }
  | { readonly name: string; readonly provider: "openai-codex" };

/** An account's name: one or more ASCII letters, digits, `_` or `-`. */
export const accountName: RegExp = /^[A-Za-z0-9_-]+$/u;

/** What the operator chose, kept between sessions (#443). */
export interface Settings {
  readonly accounts?: readonly Account[];
  /** The model, as `provider/id`. */
  readonly model?: string;
  /** Verification role models (#709); the session model when absent. Only open cases accepts `off`. */
  readonly openCasesModel?: string;
  readonly claimcheckModel?: string;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly tuiMode?: TuiMode;
  /** How freely the agent may act (#449): read only, ask, or full access; ask when not set. */
  readonly permissionMode?: Mode;
  /** This installation's id, a UUID, which some providers' login asks for. */
  readonly deviceId?: string;
  /** How many subagents may run at once across a session's tree (#525), from 1 to 16; 4 when not set. */
  readonly agentLimit?: number;
  /**
   * Whether Git keeps a writing subagent off every branch but its own (#619):
   * `require` starts none without it, `warn` starts one unguarded and says
   * so, `off` never guards; `require` when not set.
   */
  readonly subagentBranchGuard?: GuardSetting;
}

const modelName = (value: unknown): boolean => typeof value === "string" && /^[^/\s]+\/\S+$/u.test(value);

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modes = new Set(["fullscreen", "inline"]);
const permissionModes = new Set(["read", "ask", "full"]);
const guardSettings = new Set(["require", "warn", "off"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Each setting's check; a value that fails it is left out and named. */
const checks: { readonly [Name in keyof Settings]-?: (value: unknown) => boolean } = {
  accounts: (value) => {
    if (!Array.isArray(value)) return false;
    const ids = new Set<string>();
    return value.every((item: unknown) => {
      if (typeof item !== "object" || item === null) return false;
      const name: unknown = Reflect.get(item, "name");
      const provider: unknown = Reflect.get(item, "provider");
      const folder: unknown = Reflect.get(item, "folder");
      if (typeof name !== "string" || !accountName.test(name)) return false;
      if (provider !== "openai-codex" && provider !== "claude-code") return false;
      if (provider === "claude-code" && (typeof folder !== "string" || !isAbsolute(folder))) return false;
      if (provider === "openai-codex" && folder !== undefined) return false;
      const id = `${provider}@${name}`;
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });
  },
  model: modelName,
  openCasesModel: (value) => value === "off" || modelName(value),
  claimcheckModel: modelName,
  thinkingLevel: (value) => levels.has(value as string),
  tuiMode: (value) => modes.has(value as string),
  permissionMode: (value) => permissionModes.has(value as string),
  deviceId: (value) => typeof value === "string" && uuid.test(value),
  agentLimit: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 16,
  subagentBranchGuard: (value) => guardSettings.has(value as string),
};

/** The settings read back, and the names of those that were invalid and left out. */
export interface ReadSettings {
  readonly settings: Settings;
  readonly invalid: readonly string[];
}

/**
 * The operator's settings (#443) in `~/.tesota/settings.json` unless given
 * another file: none when it does not exist, each value checked, and one
 * that fails left out and named so the shell can say so. A file that is not
 * JSON is a failure, never read as empty.
 */
export function readSettings(path: string = join(tesotaHome(), "settings.json")): ReadSettings {
  const parsed = readFile(path);
  const settings: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [name, check] of Object.entries(checks)) {
    const value = Reflect.get(parsed, name);
    if (value === undefined) continue;
    if (check(value)) settings[name] = value;
    else invalid.push(name);
  }
  return { settings: settings as Settings, invalid };
}

/** The settings file's object as written, hooks and keys Tesota leaves out included; none when it does not exist. */
function readFile(path: string): object {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const parsed: unknown = parseJson(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} does not hold settings.`);
  return parsed;
}

/** Writes the operator's settings, whole or not at all. */
export function writeSettings(settings: Settings, path: string = join(tesotaHome(), "settings.json")): void {
  writeWholeJson(path, settings);
}

/**
 * Writes `change` over the settings as they are now (#453): read, merged and
 * written under a lock, so two Tesotas saving at once each keep the other's
 * change; a change made from the settings as they are then, such as an
 * account added to the list, is given as a function of them. The rest of the
 * file stays as written, the operator's hooks and any value Tesota leaves out
 * included (#642). Waits up to about a second for another's save.
 */
export function updateSettings(change: Partial<Settings> | ((current: Settings) => Partial<Settings>),
  path: string = join(tesotaHome(), "settings.json")): void {
  // The lock is beside the file, so a first save, as a first login's, makes their folder.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withLock(`${path}.lock`, () => {
    const changed = typeof change === "function" ? change(readSettings(path).settings) : change;
    writeWholeJson(path, { ...readFile(path), ...changed });
  });
}

/** This installation's id, made and kept the first time a login asks for it. */
export function deviceId(path: string = join(tesotaHome(), "settings.json")): string {
  const { settings } = readSettings(path);
  if (settings.deviceId !== undefined) return settings.deviceId;
  const made = randomUUID();
  updateSettings({ deviceId: made }, path);
  return made;
}
