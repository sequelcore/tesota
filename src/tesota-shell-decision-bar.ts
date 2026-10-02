import { truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { bold, colorText, mutedText, selectedRow, type TesotaShellTheme } from "./tesota-shell-theme.js";
import { decisionLevel } from "./verification/decision-bar-rule.js";

/** A session's turns in the operator's files that are neither kept nor reverted, and whether a reverted one can be put back. */
export interface UndecidedTurns {
  readonly turns: number;
  readonly files: number;
  readonly redoable: boolean;
}

export type DecisionAction = "keep" | "revert" | "redo" | "diff";
const actionLabels: Readonly<Record<DecisionAction, string>> = { keep: "Keep", revert: "Revert", redo: "Redo", diff: "Diff" };

/** What the bar offers for a session's undecided turns: nothing when there is nothing to decide. */
export function decisionActions(undecided: UndecidedTurns | undefined, hasDiff: boolean): readonly DecisionAction[] {
  if (undecided === undefined) return [];
  const turns: DecisionAction[] = undecided.turns > 0 ? ["keep", "revert", ...hasDiff ? ["diff" as const] : []] : [];
  return [...turns, ...undecided.redoable ? ["redo" as const] : []];
}

/**
 * The bar's words for a width: its actions always whole, so each stays a
 * target to click, and as room runs out first a shorter hint, then none,
 * then the count without its files, rather than a line cut mid-word.
 */
export function decisionLayout(undecided: UndecidedTurns, actions: readonly DecisionAction[], width: number):
  Readonly<{ summary: string; hint: string }> {
  const turns = undecided.turns === 0 ? "Turn reverted" : `${undecided.turns} ${undecided.turns === 1 ? "turn" : "turns"} undecided`;
  const files = undecided.turns === 0 ? turns : `${turns} · ${undecided.files} ${undecided.files === 1 ? "file" : "files"}`;
  const [full, short] = actions.includes("keep") ? ["or /keep /revert · a new request continues on top", "or /keep /revert"]
    : ["or /redo", "or /redo"];
  // Each action is drawn as ` Label `, one column apart; the summary and a hint stand two apart from them.
  const buttons = actions.reduce((sum, action) => sum + actionLabels[action].length + 3, 0) - 1;
  const needs = (summary: string, hint: string): number => 1 + summary.length + 2 + buttons + (hint === "" ? 0 : 2 + hint.length);
  const layouts = [{ summary: files, hint: full }, { summary: files, hint: short }, { summary: files, hint: "" }, { summary: turns, hint: "" }];
  return layouts[decisionLevel(width, needs(files, full), needs(files, short), needs(files, ""))] ?? { summary: turns, hint: "" };
}

/**
 * Above the prompt while a session's turns in the operator's files wait for
 * a decision, as editors that write an agent's changes in place offer Keep
 * and Undo: what is undecided and the actions on it, each chosen with a click
 * or a tap. It never holds the session, since a new request continues on top
 * of the turn, and no key acts on it alone, since a letter typed to start a
 * request must never revert a turn; `/keep`, `/revert` and `/redo` remain.
 */
export class DecisionBar implements Component {
  readonly #theme: TesotaShellTheme;
  readonly #state: () => { undecided: UndecidedTurns | undefined; hasDiff: boolean } | undefined;
  readonly #act: (action: DecisionAction) => void;
  /** Where each action's label was drawn, for a click to choose it. */
  #labels: { action: DecisionAction; start: number; end: number }[] = [];

  constructor(theme: TesotaShellTheme, state: () => { undecided: UndecidedTurns | undefined; hasDiff: boolean } | undefined,
    act: (action: DecisionAction) => void) {
    this.#theme = theme;
    this.#state = state;
    this.#act = act;
  }

  get visible(): boolean { return this.#actions().length > 0; }
  invalidate(): void {}

  #actions(): readonly DecisionAction[] {
    const state = this.#state();
    return state === undefined ? [] : decisionActions(state.undecided, state.hasDiff);
  }

  render(width: number): string[] {
    const actions = this.#actions();
    this.#labels = [];
    const undecided = this.#state()?.undecided;
    if (actions.length === 0 || undecided === undefined) return [];
    const { summary, hint } = decisionLayout(undecided, actions, width);
    let column = 1 + visibleWidth(summary) + 2;
    const buttons = actions.map((action) => {
      const label = ` ${actionLabels[action]} `;
      this.#labels.push({ action, start: column, end: column + label.length });
      column += label.length + 1;
      return bold(selectedRow(label, label.length, this.#theme));
    });
    const line = ` ${colorText(summary, this.#theme.warning)}  ${buttons.join(" ")}${hint === "" ? "" : `  ${mutedText(hint, this.#theme)}`}`;
    return [truncateToWidth(line, width)];
  }

  /** A press on an action's label is taken, so the click that follows it reaches here and acts. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click") || event.y !== 0) return undefined;
    const label = this.#labels.find(({ start, end }) => event.x >= start && event.x < end);
    if (label === undefined) return undefined;
    if (event.type === "click") this.#act(label.action);
    return { handled: true, render: event.type === "click" };
  }
}
