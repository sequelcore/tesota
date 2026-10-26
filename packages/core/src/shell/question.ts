import { type Focusable, Input, matchesKey, ScrollView, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { terminalText } from "../../../../src/terminal-text.ts";
import { BAR_WIDTH, barLines, frameTitle } from "./frame.ts";
import type { ClarificationAnswer, ClarificationQuestion } from "../../../../src/clarification.ts";
import type { QuestionSubmit } from "../questions.ts";
import { listRow, type ShellTheme } from "../../../../src/theme.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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
  #inPaste = false;
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
    data = this.pasteAsOneLine(data);
    if (this.browse(data)) return;
    this.#revealFocus = true;
    if (matchesKey(data, "escape")) { this.cancel(); return; }
    if (matchesKey(data, "up")) { this.moveRow(-1); return; }
    if (matchesKey(data, "down")) { this.moveRow(1); return; }
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

  /**
   * pi-tui's single-line `Input` deletes the line breaks of a bracketed paste, joining words (#624). The field holds
   * one line, so each break (`\r\n`, `\n` or `\r`) becomes a space before it gets there. A paste can arrive in
   * several chunks, so whether one is open is remembered; typed Enter outside a paste is untouched.
   */
  private pasteAsOneLine(data: string): string {
    let out = "";
    let rest = data;
    for (;;) {
      const marker = this.#inPaste ? PASTE_END : PASTE_START;
      const at = rest.indexOf(marker);
      const chunk = at < 0 ? rest : rest.slice(0, at + marker.length);
      out += this.#inPaste ? chunk.replace(/\r\n|\r|\n/gu, " ") : chunk;
      if (at < 0) return out;
      this.#inPaste = !this.#inPaste;
      rest = rest.slice(at + marker.length);
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
    // Framed as everything in the input's place (#531): a count only when there are several, then the question as the
    // title, a blank row, and the choices with the text and submit action that complete them; `footerLines` follows.
    const inner = Math.max(1, width - BAR_WIDTH);
    const several = this.questions.length > 1;
    const lines = [
      ...several ? new Text(this.theme.fg("dim", `Question ${this.draft.question + 1}/${this.questions.length}`), 0, 0).render(inner) : [],
      ...new Text(frameTitle(this.theme, terminalText(question.question)), 0, 0).render(inner),
      "",
    ];
    for (const [index, option] of question.options.entries()) {
      const focus = this.draft.field === "choices" && index === this.draft.option;
      if (focus) this.#focusRow = lines.length;
      const checked = selected.has(index) ? "[x]" : "[ ]";
      const recommended = question.recommended === index ? " (recommended)" : "";
      lines.push(...new Text(this.marked(focus, `${index + 1}. ${checked} ${terminalText(option.label)}${recommended}`), 0, 0).render(inner));
      lines.push(...new Text(this.theme.fg("dim", terminalText(option.description)), 5, 0).render(inner));
    }
    const text = this.currentText();
    if (this.draft.field === "text") this.#focusRow = lines.length;
    text.focused = this.focused && this.draft.field === "text";
    // In the choices' column, past the gutter where `›` marks the focus, so the answer's parts line up.
    // Input draws a fake inverse-video cursor even when unfocused. Render the
    // inactive value as plain text so it cannot look like a second focus marker.
    const textWidth = Math.max(1, inner - 2);
    const textLines = text.focused ? text.render(textWidth)
      : [truncateToWidth(`Text: ${terminalText(text.getValue() || "optional context")}`, textWidth, "")];
    lines.push(...textLines.map((line) => `  ${line}`));
    if (this.draft.field === "submit") this.#focusRow = lines.length;
    lines.push(...new Text(this.marked(this.draft.field === "submit", "[Submit answers]"), 0, 0).render(inner));
    return barLines(this.theme, "answer", lines.map((line) => listRow(this.theme, line, inner)));
  }

  /** `text` behind the focus marker when it has the focus, as pi-tui's lists draw it. */
  private marked(focus: boolean, text: string): string {
    return focus ? `${this.theme.selectList.selectedPrefix("› ")}${this.theme.selectList.selectedText(text)}` : `  ${text}`;
  }

  /**
   * What stays under the choices however far they scroll: a blank row, the
   * way on from the focus, and why a submission was refused, so a question
   * taller than the terminal never hides how to answer it.
   */
  footerLines(width: number): string[] {
    const inner = Math.max(1, width - BAR_WIDTH);
    return barLines(this.theme, "answer", ["", ...new Text(this.theme.fg("dim", this.hint()), 0, 0).render(inner),
      ...this.#error === undefined ? [] : new Text(this.theme.fg("error", this.#error), 0, 0).render(inner)]);
  }

  /** The way on from where the focus is, so the submit action is found without knowing the keys. */
  private hint(): string {
    if (this.draft.field === "choices") return `${this.questions.length > 1 ? "←/→ questions · " : ""}↑/↓ moves · Space selects · Tab adds text · Esc cancels`;
    return this.draft.field === "text" ? "↑/↓ moves · Tab or Enter goes to Submit · Esc cancels" : "↑/↓ moves · Enter submits · Tab goes back to the choices · Esc cancels";
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

  private moveRow(offset: number): void {
    const count = this.currentQuestion().options.length;
    const row = this.draft.field === "choices" ? this.draft.option : count + (this.draft.field === "submit" ? 1 : 0);
    const next = (row + offset + count + 2) % (count + 2);
    this.draft.field = next < count ? "choices" : next === count ? "text" : "submit";
    if (next < count) this.draft.option = next;
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
