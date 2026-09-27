import { SelectList, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { bold, colorText, mutedText, TESOTA_SHELL_THEME_DESCRIPTIONS, TESOTA_SHELL_THEME_NAMES,
  type TesotaShellTheme } from "./tesota-shell-theme.js";

export class ThemePicker implements Component {
  readonly #theme: TesotaShellTheme;
  readonly #list: SelectList;
  #query: string | undefined;
  #enabled = false;
  #dismissed = false;

  constructor(theme: TesotaShellTheme) {
    this.#theme = theme;
    this.#list = new SelectList(TESOTA_SHELL_THEME_NAMES.map((name) => ({
      value: name, label: name, description: TESOTA_SHELL_THEME_DESCRIPTIONS[name],
    })), 7, {
      selectedPrefix: (text) => colorText(text, theme.accent), selectedText: bold,
      description: (text) => mutedText(text, theme), scrollInfo: (text) => mutedText(text, theme),
      noMatch: () => mutedText("  No matching themes", theme),
    });
  }

  get visible(): boolean { return this.#enabled && !this.#dismissed && this.#query !== undefined; }
  get choice(): string | undefined { return this.#list.getSelectedItem()?.value; }

  update(value: string, enabled: boolean): void {
    const rest = value.startsWith("/themes ") ? value.slice(8) : undefined;
    const query = rest !== undefined && !/\s/u.test(rest) ? rest : undefined;
    this.#enabled = enabled;
    if (query !== this.#query) {
      this.#dismissed = false;
      this.#list.setFilter(query ?? "");
      if (query === "") this.#list.setSelectedIndex(TESOTA_SHELL_THEME_NAMES.indexOf(this.#theme.name));
    }
    this.#query = query;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.#dismissed = true;
    else this.#list.handleInput(data);
  }

  invalidate(): void { this.#list.invalidate(); }
  render(width: number): string[] {
    if (!this.visible || width < 8) return [];
    const heading = `  Theme: ${this.#theme.name} · ↑↓ choose · Enter switch · Esc close`;
    return [mutedText(truncateToWidth(heading, width), this.#theme), ...this.#list.render(width)];
  }
}
