import { type Component, fuzzyFilter, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bold, mutedText, selectedRow, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { formatTokens } from "./token-usage.js";

/**
 * The `/model` picker (decision 026): the agent's model chosen from a list,
 * as in Claude Code and Codex, while `/model <route:model>` still works when
 * typed. Typing after `/model ` filters the list; left and right choose a
 * reasoning level for the highlighted model, as Claude Code's effort slider
 * does (decision 029); Enter switches. `/models` uses the same picker to
 * choose a role, then `/models <role> ` that role's model, which it keeps for
 * every session, as `tesota models` does.
 */

export interface ModelPickerEntry {
  /** The choice as `route:model`. */
  readonly id: string;
  /** Who pays for it, and its list price. */
  readonly detail: string;
  /** The reasoning levels it accepts; empty when it takes none. */
  readonly reasoning: readonly string[];
}

export interface ModelPickerData {
  /** What is chosen, as the picker's heading names it; the agent's model when not given. */
  readonly title?: string;
  /** Choosing fills in the command's next argument rather than running it: a role, before its model. */
  readonly completes?: boolean;
  /** The current choice, with its level when it has one. */
  readonly current: string;
  /** What the agent's next model call re-reads, when it has made one: the cost of switching model or level. */
  readonly contextTokens?: number | undefined;
  readonly entries: readonly ModelPickerEntry[];
}

/**
 * What the picker completes in the editor: `/model `, `/models ` for a role,
 * or `/models <role> ` for that role's model; undefined when it stays closed.
 */
export function pickerPrefix(value: string): string | undefined {
  if (value.startsWith("/model ")) return "/model ";
  const role = /^\/models [^\s]+ /u.exec(value);
  if (role !== null) return role[0];
  return value.startsWith("/models ") ? "/models " : undefined;
}

const maxRows = 8;
/** A model without a chosen level runs at its engine's default. */
const DEFAULT_LEVEL = "default";

export class ModelPicker implements Component {
  readonly #theme: TesotaShellTheme;
  #data: ModelPickerData | undefined;
  #prefix: string | undefined;
  #query = "";
  #enabled = false;
  #dismissed = false;
  #selected = 0;
  /** The level chosen for each model while the picker is open, as an index into its levels. */
  readonly #levels = new Map<string, number>();

  constructor(theme: TesotaShellTheme) { this.#theme = theme; }

  #choices(entry: ModelPickerEntry): string[] { return [DEFAULT_LEVEL, ...entry.reasoning]; }

  #current(): { id: string; level: string } {
    const [id = "", level = DEFAULT_LEVEL] = (this.#data?.current ?? "").split("@");
    return { id, level };
  }

  #level(entry: ModelPickerEntry): number {
    const chosen = this.#levels.get(entry.id);
    if (chosen !== undefined) return chosen;
    const current = this.#current();
    return entry.id === current.id ? Math.max(0, this.#choices(entry).indexOf(current.level)) : 0;
  }

  get matches(): readonly ModelPickerEntry[] {
    const entries = this.#data?.entries ?? [];
    return this.#query === "" ? entries : fuzzyFilter([...entries], this.#query, (entry) => entry.id);
  }

  get visible(): boolean { return this.#enabled && !this.#dismissed && this.#data !== undefined && this.matches.length > 0; }

  /** The highlighted model as a `/model` argument, with its level when one other than the default is chosen. */
  get choice(): string | undefined {
    const entry = this.visible ? this.matches[this.#selected] : undefined;
    if (entry === undefined) return undefined;
    const level = this.#choices(entry)[this.#level(entry)] ?? DEFAULT_LEVEL;
    return level === DEFAULT_LEVEL ? entry.id : `${entry.id}@${level}`;
  }

  /** The command the highlighted choice completes, such as `/model `. */
  get prefix(): string | undefined { return this.#prefix; }

  /** Whether choosing fills in the next argument rather than running the command. */
  get completes(): boolean { return this.#data?.completes === true; }

  /**
   * Follow the editor: the picker is open while it holds a picker's prefix
   * and a filter with no space or level; `load` gives the choices when it
   * opens, or when the prefix changes, such as once a role is chosen.
   */
  update(value: string, enabled: boolean, load: (prefix: string) => ModelPickerData | undefined): void {
    const prefix = pickerPrefix(value);
    const rest = prefix === undefined ? undefined : value.slice(prefix.length);
    this.#enabled = enabled;
    if (prefix !== this.#prefix) this.#data = undefined;
    this.#prefix = prefix;
    if (prefix === undefined || rest === undefined || /[\s@]/u.test(rest)) {
      this.#data = undefined;
      this.#query = "";
      return;
    }
    if (this.#data === undefined) {
      this.#data = load(prefix);
      this.#levels.clear();
      this.#dismissed = false;
      this.#query = rest;
      const current = this.#current().id;
      this.#selected = rest === "" ? Math.max(0, this.matches.findIndex((entry) => entry.id === current)) : 0;
      return;
    }
    if (rest !== this.#query) { this.#query = rest; this.#selected = 0; this.#dismissed = false; }
  }

  move(offset: number): void {
    const count = this.matches.length;
    if (count > 0) this.#selected = (this.#selected + offset + count) % count;
  }

  /** Step the highlighted model's reasoning level; a model that takes none stays at its default. */
  shiftLevel(offset: number): void {
    const entry = this.matches[this.#selected];
    if (entry === undefined || entry.reasoning.length === 0) return;
    const count = this.#choices(entry).length;
    this.#levels.set(entry.id, (this.#level(entry) + offset + count) % count);
  }

  dismiss(): void { this.#dismissed = true; }
  invalidate(): void {}

  render(width: number): string[] {
    if (!this.visible || width < 8) return [];
    const matches = this.matches;
    const start = Math.max(0, Math.min(this.#selected - Math.floor(maxRows / 2), matches.length - maxRows));
    const shown = matches.slice(start, start + maxRows);
    const idWidth = Math.min(36, Math.max(...shown.map((entry) => entry.id.length)) + 2);
    const current = this.#current().id;
    const rows = shown.map((entry, offset) => {
      const selected = start + offset === this.#selected;
      const level = this.#choices(entry)[this.#level(entry)] ?? DEFAULT_LEVEL;
      const levelText = selected && entry.reasoning.length > 0 ? `‹ ${level} ›` : level === DEFAULT_LEVEL ? "" : level;
      const line = truncateToWidth(`${selected ? "›" : " "} ${entry.id === current ? "●" : " "} ${entry.id.padEnd(idWidth)}` +
        `${levelText.padEnd(12)}${entry.detail}`, width);
      return selected ? selectedRow(bold(line), width, this.#theme) : mutedText(line, this.#theme);
    });
    const position = matches.length > maxRows ? ` · ${this.#selected + 1}/${matches.length}` : "";
    const context = this.#data?.contextTokens;
    // Caches belong to one model and level (decision 026): a switch's cost is known before it is made.
    const cost = context === undefined ? [] : wrapTextWithAnsi(`  A switch re-reads about ${formatTokens(context)} without cache; ` +
      "/handoff starts fresh.", width).map((line) => mutedText(line, this.#theme));
    const heading = `  ${this.#data?.title ?? "Agent model"} · ↑↓ choose · ${this.completes ? "" : "←→ reasoning · "}` +
      `Enter ${this.completes ? "choose" : "switch"} · Esc close${position}`;
    return [mutedText(truncateToWidth(heading, width),
      this.#theme), ...cost, ...rows];
  }
}
