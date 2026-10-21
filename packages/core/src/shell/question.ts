import { type Focusable, Input, matchesKey, ScrollView, Text } from "@earendil-works/pi-tui";
import { terminalText } from "../../../../src/terminal-text.ts";
import type { ClarificationAnswer, ClarificationQuestion } from "../../../../src/clarification.ts";
import type { QuestionSubmit } from "../questions.ts";
import type { ShellTheme } from "../../../../src/theme.ts";

type Field = "choices" | "text" | "submit";

export interface QuestionDraft {
  question: number;
  option: number;
  field: Field;
  readonly selected: Set<number>[];
  readonly text: string[];
}

export function createQuestionDraft(questions: readonly ClarificationQuestion[]): QuestionDraft {
  return { question: 0, option: 0, field: "choices", selected: questions.map(() => new Set<number>()), text: questions.map(() => "") };
}

/**
 * The one form an operator explicitly submits for an `ask_user` call. Its
 * mutable draft lives with the form, so hiding and showing the session never
 * rewrites an answer or silently chooses the recommendation.
 */
export class QuestionForm extends ScrollView implements Focusable {
  focused = false;
  #submitted = false;
  #error: string | undefined;
  #focusRow = 0;
  #revealFocus = true;
  #width = 0;
  readonly #text: Input[];
  readonly questions: readonly ClarificationQuestion[];
  readonly submit: QuestionSubmit;
  readonly cancel: () => void;
  readonly theme: ShellTheme;
  readonly draft: QuestionDraft;
  readonly active: () => boolean;
  readonly inlineViewport: { height(width: number): number; redraw(): void } | undefined;

  constructor(questions: readonly ClarificationQuestion[], submit: QuestionSubmit, cancel: () => void, theme: ShellTheme,
    draft: QuestionDraft, active: () => boolean, inlineViewport?: { height(width: number): number; redraw(): void }) {
    super({ render: (width) => this.renderContent(width), invalidate: () => undefined }, { primary: true, overscroll: "contain", scrollbar: "always" });
    this.questions = questions;
    this.submit = submit;
    this.cancel = cancel;
    this.theme = theme;
    this.draft = draft;
    this.active = active;
    this.inlineViewport = inlineViewport;
    this.#text = questions.map((_, index) => {
      const input = new Input({ prompt: "Text: ", placeholder: "optional context" });
      input.setValue(draft.text[index] ?? "");
      return input;
    });
  }

  override invalidate(): void {
    for (const input of this.#text) input.invalidate();
  }

  handleInput(data: string): void {
    if (this.#submitted || !this.active()) return;
    if (this.browse(data)) return;
    this.#revealFocus = true;
    if (matchesKey(data, "escape")) { this.cancel(); return; }
    if (this.draft.field === "text") {
      const text = this.currentText();
      if (matchesKey(data, "tab") || matchesKey(data, "enter")) { this.draft.field = "submit"; return; }
      text.handleInput(data);
      this.draft.text[this.draft.question] = text.getValue();
      return;
    }
    if (matchesKey(data, "left")) { this.moveQuestion(-1); return; }
    if (matchesKey(data, "right")) { this.moveQuestion(1); return; }
    if (matchesKey(data, "tab")) { this.draft.field = this.draft.field === "choices" ? "text" : "choices"; return; }
    if (matchesKey(data, "up")) { this.moveOption(-1); return; }
    if (matchesKey(data, "down")) { this.moveOption(1); return; }
    if (matchesKey(data, "enter")) {
      if (this.draft.field === "submit") this.save();
      else this.toggle(this.draft.option);
      return;
    }
    // Selection keys act on the choices only: on the submit action they would change an answer the operator cannot see.
    if (this.draft.field !== "choices") return;
    if (matchesKey(data, "space")) { this.toggle(this.draft.option); return; }
    if (/^[1-4]$/u.test(data)) {
      const index = Number(data) - 1;
      if (index < this.currentQuestion().options.length) this.toggle(index);
    }
  }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    if (viewportHeight !== this.viewportHeight) this.#revealFocus = true;
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    if (!this.#revealFocus) return;
    this.#revealFocus = false;
    if (this.#focusRow < this.scrollTop || this.#focusRow >= this.scrollTop + viewportHeight) this.scrollTo(this.#focusRow);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.inlineViewport === undefined) return lines;
    this.updateLayout(lines.length, this.inlineViewport.height(width), this.inlineViewport.redraw);
    return lines.slice(this.scrollTop, this.scrollTop + this.viewportHeight);
  }

  private browse(data: string): boolean {
    const up = matchesKey(data, "pageUp");
    if (!up && !matchesKey(data, "pageDown")) return false;
    this.#revealFocus = false;
    this.scrollBy((up ? -1 : 1) * Math.max(1, this.viewportHeight - 1));
    return true;
  }

  private renderContent(width: number): string[] {
    if (width !== this.#width) { this.#width = width; this.#revealFocus = true; }
    const question = this.currentQuestion();
    const selected = this.draft.selected[this.draft.question];
    if (selected === undefined) return [];
    const lines = [
      ...new Text(this.theme.bold(this.theme.fg("accent", `Question ${this.draft.question + 1}/${this.questions.length}`)), 0, 0).render(width),
      ...new Text(terminalText(question.question), 0, 0).render(width),
    ];
    for (const [index, option] of question.options.entries()) {
      if (this.draft.field === "choices" && index === this.draft.option) this.#focusRow = lines.length;
      const cursor = this.draft.field === "choices" && index === this.draft.option ? "› " : "  ";
      const checked = selected.has(index) ? "[x]" : "[ ]";
      const recommended = question.recommended === index ? " (recommended)" : "";
      const label = `${cursor}${index + 1}. ${checked} ${terminalText(option.label)}${recommended}`;
      lines.push(...new Text(this.draft.field === "choices" && index === this.draft.option ? this.theme.fg("accent", label) : label, 0, 0).render(width));
      lines.push(...new Text(this.theme.fg("dim", terminalText(option.description)), 5, 0).render(width));
    }
    const text = this.currentText();
    if (this.draft.field === "text") this.#focusRow = lines.length;
    text.focused = this.focused && this.draft.field === "text";
    lines.push(...text.render(width));
    const submit = this.draft.field === "submit" ? this.theme.fg("accent", "› [Submit answers]") : "  [Submit answers]";
    if (this.draft.field === "submit") this.#focusRow = lines.length;
    lines.push(...new Text(submit, 0, 0).render(width));
    // The hint names the way on from where the focus is, so the submit action is found without knowing the keys.
    const hint = this.draft.field === "choices" ? "←/→ questions · Space selects · Tab adds text · Esc cancels"
      : this.draft.field === "text" ? "Tab or Enter goes to Submit · Esc cancels"
        : "Enter submits · Tab goes back to the choices · Esc cancels";
    lines.push(...new Text(this.theme.fg("dim", hint), 0, 0).render(width));
    if (this.#error !== undefined) lines.push(...new Text(this.theme.fg("error", this.#error), 0, 0).render(width));
    return lines;
  }

  private currentQuestion(): ClarificationQuestion {
    return this.questions[this.draft.question] as ClarificationQuestion;
  }

  private currentText(): Input {
    return this.#text[this.draft.question] as Input;
  }

  private moveQuestion(offset: number): void {
    this.draft.question = (this.draft.question + offset + this.questions.length) % this.questions.length;
    this.draft.option = 0;
    this.draft.field = "choices";
    this.scrollToStart();
  }

  private moveOption(offset: number): void {
    const count = this.currentQuestion().options.length;
    this.draft.option = (this.draft.option + offset + count) % count;
  }

  private toggle(index: number): void {
    const selected = this.draft.selected[this.draft.question] as Set<number>;
    const question = this.currentQuestion();
    if (selected.has(index)) { selected.delete(index); return; }
    if (question.multiple !== true) selected.clear();
    selected.add(index);
  }

  private save(): void {
    const answers: readonly ClarificationAnswer[] = this.questions.map((_, index) => {
      const text = (this.#text[index] as Input).getValue();
      return { selected: [...(this.draft.selected[index] as Set<number>)].sort((a, b) => a - b), ...text === "" ? {} : { text } };
    });
    const error = this.submit(answers);
    if (error === undefined) this.#submitted = true;
    else this.#error = error;
  }
}
