import { expect, test } from "bun:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { VirtualTerminal } from "./virtual-terminal.ts";
import type { ClarificationQuestion } from "../../../src/clarification.ts";
import { shellTheme } from "../../../src/theme.ts";
import { createQuestionDraft, QuestionForm } from "../src/shell/question.ts";

const questions: readonly ClarificationQuestion[] = [{ question: "Which?", options: [
  { label: "A", description: "first" }, { label: "B", description: "second" },
], recommended: 1 }];

function form(appearance: "dark" | "light" = "dark") {
  const draft = createQuestionDraft(questions);
  const view = new QuestionForm(questions, () => undefined, () => undefined,
    shellTheme(appearance, "truecolor"), draft, () => true);
  view.focused = true;
  return { draft, view };
}

// Keep ANSI visible in failures and snapshots: reverse-video is a background change, too.
class Rendering extends TuiMainScreen {
  ansi(view: QuestionForm): string[] {
    return this.resolveFakeCursors(view.render(60)).map((line) => line.replaceAll("\x1b", "<ESC>").replaceAll("\x07", "<BEL>").trimEnd());
  }
}

function ansi(view: QuestionForm): string[] {
  return new Rendering(new VirtualTerminal(60)).ansi(view);
}

test.each(["dark", "light"] as const)("%s question has no stray reverse-video background outside the text editor", (appearance) => {
  const { view } = form(appearance);
  const lines = ansi(view);
  expect(lines.filter((line) => line.includes("<ESC>[7m"))).toEqual([]);
});

test("Down traverses choices, text and Submit; Up traverses them in reverse without changing answers", () => {
  const { view, draft } = form();
  view.handleInput(" ");
  view.handleInput("\x1b[B");
  expect([draft.field, draft.option]).toEqual(["choices", 1]);
  view.handleInput("\x1b[B");
  expect(draft.field).toBe("text");
  view.handleInput("context");
  view.handleInput("\x1b[B");
  expect(draft.field).toBe("submit");
  view.handleInput("\x1b[A");
  expect(draft.field).toBe("text");
  view.handleInput("\x1b[A");
  expect([draft.field, draft.option]).toEqual(["choices", 1]);
  view.handleInput("\x1b[A");
  expect([draft.field, draft.option]).toEqual(["choices", 0]);
  expect([...draft.selected[0] ?? []]).toEqual([0]);
  expect(draft.text).toEqual(["context"]);
});

test("Tab still cycles choices, text, Submit and choices, preserving the current option", () => {
  const { view, draft } = form();
  view.handleInput("\x1b[B");
  for (const field of ["text", "submit", "choices"] as const) {
    view.handleInput("\t");
    expect(draft.field).toBe(field);
    expect(draft.option).toBe(1);
  }
});

test("arrows wrap through all rows at either end", () => {
  const { view, draft } = form();
  view.handleInput("\x1b[A");
  expect(draft.field).toBe("submit");
  view.handleInput("\x1b[B");
  expect([draft.field, draft.option]).toEqual(["choices", 0]);
});

test.each(["dark", "light"] as const)("%s question ANSI rendering follows the theme in each field", (appearance) => {
  const { view } = form(appearance);
  view.handleInput(" ");
  const choices = ansi(view);
  view.handleInput("\t");
  view.handleInput("notes");
  const text = ansi(view);
  view.handleInput("\t");
  const submit = ansi(view);
  expect(submit.filter((line) => line.includes("<ESC>[7m"))).toEqual([]);
  expect({ choices, text, submit }).toMatchSnapshot();
});
