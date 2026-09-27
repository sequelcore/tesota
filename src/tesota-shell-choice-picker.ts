import { SelectList, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { bold, colorText, mutedText, type TesotaShellTheme } from "./tesota-shell-theme.js";

export interface ShellChoice {
  readonly value: string;
  readonly label: string;
  readonly detail: string;
}

export class ChoicePicker implements Component {
  readonly #theme: TesotaShellTheme;
  #list: SelectList | undefined;
  #prefix: string | undefined;
  #title = "";
  #enabled = false;
  #dismissed = false;

  constructor(theme: TesotaShellTheme) { this.#theme = theme; }

  get visible(): boolean { return this.#enabled && !this.#dismissed && this.#list !== undefined; }
  get choice(): string | undefined { return this.#list?.getSelectedItem()?.value; }
  get prefix(): string | undefined { return this.#prefix; }

  update(value: string, enabled: boolean,
    load: (prefix: string) => { title: string; entries: readonly ShellChoice[] } | undefined): void {
    const prefix = value.startsWith("/sandbox ") ? "/sandbox " : value.startsWith("/details ") ? "/details " : undefined;
    const query = prefix === undefined ? undefined : value.slice(prefix.length);
    this.#enabled = enabled;
    if (prefix !== this.#prefix) {
      this.#prefix = prefix;
      this.#dismissed = false;
      this.#list = undefined;
    }
    if (prefix !== undefined && query !== undefined && !/\s/u.test(query)) {
      const data = this.#list === undefined ? load(prefix) : undefined;
      if (data !== undefined) this.#title = data.title;
      if (data !== undefined && data.entries.length > 0) this.#list = new SelectList(data.entries.map((entry) => ({
        value: entry.value, label: entry.label, description: entry.detail,
      })), 8, {
        selectedPrefix: (text) => colorText(text, this.#theme.accent), selectedText: bold,
        description: (text) => mutedText(text, this.#theme), scrollInfo: (text) => mutedText(text, this.#theme),
        noMatch: () => mutedText("  No matches", this.#theme),
      });
      this.#list?.setFilter(query);
    }
    else this.#list = undefined;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.#dismissed = true;
    else this.#list?.handleInput(data);
  }

  invalidate(): void { this.#list?.invalidate(); }
  render(width: number): string[] {
    if (!this.visible || width < 8) return [];
    return [mutedText(truncateToWidth(`  ${this.#title} · ↑↓ choose · Enter select · Esc close`, width), this.#theme),
      ...(this.#list?.render(width) ?? [])];
  }
}
