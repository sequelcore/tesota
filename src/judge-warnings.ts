import { type ModelChoices, type ModelRole, type ModelRoute, parseModelChoice, ROLE_OFF } from "./model-roles.js";
import { type JudgeIndependence, judgeIndependence } from "./verification/judge-independence.js";

/**
 * Where one role judges another's output with a model too close to it
 * (decision 028). Evaluators favor their own output even on objective code
 * criteria, and favor their own family less strongly; Tesota warns and never
 * refuses, since an operator with one plan may have no other model.
 */

/** The lab behind each route's models. */
const routeLab: Readonly<Record<ModelRoute, string>> = { codex: "OpenAI", anthropic: "Anthropic", "claude-code": "Anthropic" };
/** Claude Code's aliases name a family and follow its newest model. */
const claudeFamilies = ["opus", "sonnet", "fable", "haiku"] as const;

function claudeFamily(model: string): string | undefined {
  return claudeFamilies.find((family) => model === family || model.startsWith(`claude-${family}-`));
}

/**
 * Whether two choices run the same model: the same id on a route of the same
 * lab, or a Claude Code alias and a model of its family, which the alias may
 * currently resolve to.
 */
export function sameModel(first: string, second: string): boolean {
  const a = parseModelChoice(first);
  const b = parseModelChoice(second);
  if (a === undefined || b === undefined || routeLab[a.route] !== routeLab[b.route]) return false;
  if (a.model === b.model) return true;
  const aliased = (claudeFamilies as readonly string[]).includes(a.model) || (claudeFamilies as readonly string[]).includes(b.model);
  return aliased && claudeFamily(a.model) !== undefined && claudeFamily(a.model) === claudeFamily(b.model);
}

function lab(choice: string): string | undefined {
  const parsed = parseModelChoice(choice);
  return parsed === undefined ? undefined : routeLab[parsed.route];
}

/** Each role that judges another's output, and what it judges. */
const judgements: readonly Readonly<{ author: ModelRole; judge: ModelRole; what: string }>[] = [
  { author: "agent", judge: "reviewer", what: "the reviewer judges the agent's work" },
  { author: "agent", judge: "validator", what: "the validator judges the agent's fixes" },
  { author: "agent", judge: "refuter", what: "the refuter decides whether defects in the agent's work are real" },
  { author: "advisor", judge: "reviewer", what: "the reviewer judges work the advisor's guidance shaped" },
  { author: "advisor", judge: "validator", what: "the validator judges fixes the advisor's guidance shaped" },
  { author: "reviewer", judge: "refuter", what: "the refuter tests the reviewer's findings" },
];

export interface JudgeWarning {
  readonly level: Exclude<JudgeIndependence, "independent">;
  readonly author: ModelRole;
  readonly judge: ModelRole;
  readonly text: string;
}

/** Every judging pair whose models are the same, or from the same lab; roles that are off are skipped. */
export function judgeWarnings(choices: ModelChoices): JudgeWarning[] {
  return judgements.flatMap(({ author, judge, what }): JudgeWarning[] => {
    const [a, b] = [choices[author], choices[judge]];
    if (a === ROLE_OFF || b === ROLE_OFF) return [];
    const labA = lab(a);
    const level = judgeIndependence(sameModel(a, b), labA !== undefined && labA === lab(b));
    if (level === "independent") return [];
    return [{ level, author, judge, text: level === "same_model" ? `${what}, and both use ${a}` : `${what}, and both are ${labA} models` }];
  });
}

/** The warnings as the operator reads them, or nothing when every judge is independent. */
export function describeJudgeWarnings(warnings: readonly JudgeWarning[]): string {
  const same = warnings.filter((warning) => warning.level === "same_model");
  const lab = warnings.filter((warning) => warning.level === "same_lab");
  return [
    ...same.length === 0 ? [] : ["Same model judging its own output; models favor their own work, even on code:",
      ...same.map((warning) => `  ${warning.text}`)],
    ...lab.length === 0 ? [] : ["Same lab; a smaller preference for their own family is measured:",
      ...lab.map((warning) => `  ${warning.text}`)],
  ].join("\n");
}
