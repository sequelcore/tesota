import { expect, test } from "bun:test";
import { stripTerminalSequences, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
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

test.each(["dark", "light"] as const)("%s question fills only the focused choice's inner width", (appearance) => {
  const { view } = form(appearance);
  const theme = shellTheme(appearance, "truecolor");
  const rows = view.render(60);
  const selected = rows.find((line) => stripTerminalSequences(line).startsWith("▌ › "))!;
  expect(visibleWidth(selected)).toBe(60);
  expect(selected).toContain(`${theme.getBgAnsi("selectedBg")}${theme.selectList.selectedPrefix("› ")}`);
  // ScrollView reserves its own final column for the scrollbar, outside the list's width.
  expect(selected).toContain(" \x1b[49m");
  const unselected = rows.find((line) => line.includes("2. [ ] B"))!;
  expect(unselected).not.toContain(theme.getBgAnsi("selectedBg"));
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

// pi-tui's single-line Input deletes line breaks from a paste, joining words (#624).
test.each([["\r\n", "CRLF"], ["\n", "LF"], ["\r", "CR"]])("a bracketed paste with %j breaks reaches the agent with a space for each break (%s)", (separator) => {
  const answers: unknown[] = [];
  const draft = createQuestionDraft(questions);
  const view = new QuestionForm(questions, (given) => { answers.push(given); return undefined; }, () => undefined,
    shellTheme("dark", "truecolor"), draft, () => true);
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput(`\x1b[200~Run the${separator}direct bun test${separator}and TESOTA_HOME\x1b[201~`);
  expect(draft.field).toBe("text");
  view.handleInput("\x1b[B");
  view.handleInput("\r");
  expect(answers).toEqual([[{ selected: [], text: "Run the direct bun test and TESOTA_HOME" }]]);
});

test("a paste split across inputs does not submit or move on at a break that starts a later chunk", () => {
  const { view, draft } = form();
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[B");
  view.handleInput("\x1b[200~one");
  view.handleInput("\ntwo\x1b[201~");
  expect([draft.field, draft.text[0]]).toEqual(["text", "one two"]);
});
