import { ScrollView, SelectList, VStack, decodeKittyPrintable, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { bold, colorText, mutedText, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { safeTerminalText, type NoticeTone } from "./tesota-shell-transcript.js";
import { questionShortcut } from "./verification/question-rule.js";

/** One answer to a question the shell asks, picked from a list or by its key. */
export interface QuestionOption<V extends string = string> {
  readonly value: V;
  /** The single key that picks it at once, such as `y`. */
  readonly key: string;
  readonly label: string;
  /** What the conversation keeps once it is picked; none when what follows the answer says it already. */
  readonly decided?: Readonly<{ text: string; tone: NoticeTone }>;
}

/**
 * A question with a fixed set of answers, such as whether a command runs. The
 * operator picks one in a list that replaces the input while it waits, so
 * nothing typed there is taken as the answer, and the answer is typed.
 */
export interface ShellQuestion<V extends string = string> {
  readonly title: string;
  /** Why it is asked, such as the agent's reason for a command. */
  readonly detail?: string;
  /** A risk the operator must not miss, drawn in the theme's warning color after the detail. */
  readonly caution?: string;
  readonly options: readonly QuestionOption<V>[];
  /** The answer Enter picks until another is chosen; the safe one. */
  readonly initial: V;
}

/** The option a key picks, matched without case; the list's own keys are never options. */
export function optionForKey<V extends string>(options: readonly QuestionOption<V>[], data: string): QuestionOption<V> | undefined {
  return options[questionShortcut(options.map((option) => option.key.toLowerCase()), data.toLowerCase())];
}

/** A question waiting on the operator, drawn in place of the input: the question whole, its answers, and its keys. */
export class QuestionPanel extends VStack {
  readonly question: ShellQuestion;
  readonly #theme: TesotaShellTheme;
  readonly #list: SelectList;
  readonly #body: ScrollView;

  constructor(question: ShellQuestion, theme: TesotaShellTheme) {
    super();
    this.question = question;
    this.#theme = theme;
    this.#list = new SelectList(question.options.map((option) => ({
      value: option.value, label: `${option.key}  ${safeTerminalText(option.label)}`,
    })), question.options.length, {
      selectedPrefix: (text) => colorText(text, theme.accent), selectedText: (text) => bold(colorText(text, theme.accent)),
      description: (text) => mutedText(text, theme), scrollInfo: (text) => mutedText(text, theme),
      noMatch: (text) => mutedText(text, theme),
    });
    this.#list.setSelectedIndex(question.options.findIndex((option) => option.value === question.initial));
    this.#body = new ScrollView({ invalidate: () => {}, render: (width) => this.renderQuestion(width) },
      { scrollbar: "auto", overscroll: "contain" });
    const rule: Component = { invalidate: () => {}, render: (width) => [mutedText("─".repeat(width), theme)] };
    this.addChild(rule, { shrink: 0 });
    this.addChild(this.#body, { basis: "auto", minSize: 1 });
    this.addChild(this.#list, { shrink: 0 });
    this.addChild({ invalidate: () => {}, render: (width) => [mutedText(truncateToWidth(
      ` ↑↓ choose · Enter confirm · ${question.options.map((option) => option.key).join(" ")} · Esc stop · Ctrl+PgUp/PgDn read`, width), theme)] },
    { shrink: 0 });
    this.addChild(rule, { shrink: 0 });
  }

  /** The answer a key gives: the highlighted one on Enter, or the one it names; arrows move the highlight. */
  handleKey(data: string): QuestionOption | "moved" | undefined {
    if (matchesKey(data, "ctrl+pageUp") || matchesKey(data, "ctrl+pageDown")) {
      this.#body.scrollBy((matchesKey(data, "ctrl+pageUp") ? -1 : 1) * Math.max(1, this.#body.viewportHeight - 1));
      return "moved";
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) { this.#list.handleInput(data); return "moved"; }
    if (matchesKey(data, "enter")) {
      const value = this.#list.getSelectedItem()?.value;
      return this.question.options.find((option) => option.value === value);
    }
    return optionForKey(this.question.options, decodeKittyPrintable(data) ?? data);
  }

  private renderQuestion(width: number): string[] {
    const theme = this.#theme;
    const inner = Math.max(1, width - 2);
    // What is approved must be readable whole: a hidden tail could be the dangerous part.
    const title = wrapTextWithAnsi(bold(safeTerminalText(this.question.title)), inner);
    const detail = this.question.detail === undefined ? [] :
      wrapTextWithAnsi(mutedText(safeTerminalText(this.question.detail), theme), inner);
    const caution = this.question.caution === undefined ? [] :
      wrapTextWithAnsi(colorText(safeTerminalText(this.question.caution), theme.warning), inner);
    return [...title, ...detail, ...caution].map((line) => ` ${line}`);
  }
}
