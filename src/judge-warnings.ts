import { type ModelChoices, type ModelRole, type ModelRoute, parseModelChoice, ROLE_OFF } from "./model-roles.js";
import { type JudgeIndependence, judgeIndependence } from "./verification/judge-independence.js";

/**
 * Where one role judges another's output with a model too close to it
 * (decision 028). Evaluators favor their own output even on objective code
 * criteria, and favor their own family less strongly; Tesota warns and never
 * refuses, since an operator with one plan may have no other model.
 */

/** The lab behind every model of a route that serves one lab's models. */
const routeLab: Readonly<Partial<Record<ModelRoute, string>>> = { codex: "OpenAI", anthropic: "Anthropic", "claude-code": "Anthropic" };
/** The lab behind an OpenRouter vendor, as OpenRouter names it in `vendor/model`. */
const vendorLab: Readonly<Record<string, string>> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google", "x-ai": "xAI",
  "z-ai": "Z.ai", moonshotai: "Moonshot AI", qwen: "Alibaba", deepseek: "DeepSeek", minimax: "MiniMax", xiaomi: "Xiaomi",
  meta: "Meta", "meta-llama": "Meta", mistralai: "Mistral AI", nvidia: "NVIDIA", inclusionai: "inclusionAI", tencent: "Tencent",
  meituan: "Meituan", "bytedance-seed": "ByteDance", amazon: "Amazon", cohere: "Cohere" };
/** The lab behind an OpenCode model, by the family its id starts with. */
const familyLab: Readonly<Record<string, string>> = { claude: "Anthropic", gpt: "OpenAI", gemini: "Google", grok: "xAI", glm: "Z.ai",
  kimi: "Moonshot AI", qwen: "Alibaba", deepseek: "DeepSeek", minimax: "MiniMax", mimo: "Xiaomi", muse: "Meta", nemotron: "NVIDIA",
  ling: "inclusionAI", hy: "Tencent", longcat: "Meituan" };
/** Claude Code's aliases name a family and follow its newest model. */
const claudeFamilies = ["opus", "sonnet", "fable", "haiku"] as const;

function claudeFamily(model: string): string | undefined {
  return claudeFamilies.find((family) => model === family || model.startsWith(`claude-${family}-`));
}

/** An alias that follows a family's newest model: Claude Code's `opus`, or OpenRouter's `~anthropic/claude-opus-latest`. */
function isAlias(model: string): boolean {
  return (claudeFamilies as readonly string[]).includes(model) || model.endsWith("-latest");
}

/**
 * A choice's lab and the model itself, the same on every route: without
 * OpenRouter's vendor, its `:variant` or its alias mark, and with its dots
 * as the other routes' dashes (`claude-opus-5.5` is `claude-opus-5-5`). A
 * router, a stealth model or an unknown vendor has no known lab.
 */
function identity(choice: string): { lab: string; model: string } | undefined {
  const parsed = parseModelChoice(choice);
  if (parsed === undefined) return undefined;
  const { route } = parsed;
  let model = parsed.model;
  let lab = routeLab[route];
  if (route === "openrouter") {
    const [vendor = "", name] = model.replace(/^~/u, "").replace(/:[^/]*$/u, "").split("/");
    if (name === undefined) return undefined;
    lab = vendorLab[vendor];
    model = name;
  } else if (route === "opencode" || route === "opencode-go") {
    lab = familyLab[model.split(/[-.\d]/u)[0] ?? ""];
  }
  return lab === undefined ? undefined : { lab, model: model.replaceAll(".", "-") };
}

/**
 * Whether two choices run the same model: the same model from the same lab,
 * on any route, or an alias and a model of its family, which the alias may
 * currently resolve to.
 */
export function sameModel(first: string, second: string): boolean {
  const a = identity(first);
  const b = identity(second);
  if (a === undefined || b === undefined || a.lab !== b.lab) return false;
  if (a.model === b.model) return true;
  return (isAlias(a.model) || isAlias(b.model)) && claudeFamily(a.model) !== undefined && claudeFamily(a.model) === claudeFamily(b.model);
}

function lab(choice: string): string | undefined {
  return identity(choice)?.lab;
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
