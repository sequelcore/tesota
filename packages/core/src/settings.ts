import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Mode } from "./permission-rule.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tesotaHome } from "../../../src/home.ts";
import { writeWholeJson } from "./whole-file.ts";

/** How the shell draws: on the alternate screen, or into the terminal's scrollback (#432). */
export type TuiMode = "fullscreen" | "inline";

/** What the operator chose, kept between sessions (#443). */
export interface Settings {
  /** The model, as `provider/id`. */
  readonly model?: string;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly tuiMode?: TuiMode;
  /** How freely the agent may act (#449): read only, ask, or full access; ask when not set. */
  readonly permissionMode?: Mode;
  /** This installation's id, a UUID, which some providers' login asks for. */
  readonly deviceId?: string;
}

const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const modes = new Set(["fullscreen", "inline"]);
const permissionModes = new Set(["read", "ask", "full"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Each setting's check; a value that fails it is left out and named. */
const checks: { readonly [Name in keyof Settings]-?: (value: unknown) => boolean } = {
  model: (value) => typeof value === "string" && /^[^/\s]+\/\S+$/u.test(value),
  thinkingLevel: (value) => levels.has(value as string),
  tuiMode: (value) => modes.has(value as string),
  permissionMode: (value) => permissionModes.has(value as string),
  deviceId: (value) => typeof value === "string" && uuid.test(value),
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
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, invalid: [] };
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${path} does not hold settings.`);
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

/** Writes the operator's settings, whole or not at all. */
export function writeSettings(settings: Settings, path: string = join(tesotaHome(), "settings.json")): void {
  writeWholeJson(path, settings);
}

/** This installation's id, made and kept the first time a login asks for it. */
export function deviceId(path: string = join(tesotaHome(), "settings.json")): string {
  const { settings } = readSettings(path);
  if (settings.deviceId !== undefined) return settings.deviceId;
  const made = randomUUID();
  writeSettings({ ...settings, deviceId: made }, path);
  return made;
}
