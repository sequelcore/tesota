import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeOrigins } from "./finding-origin.js";
import { openModelTarget } from "./integrations/model-session.js";
import { refuteFindings } from "./integrations/pi-refuter.js";
import { applicableLenses, createPiReviewer } from "./integrations/pi-reviewer.js";
import { readModelChoices } from "./model-roles.js";
import { prbenchAnswer, prbenchReviewInput } from "./prbench-review.js";
import { reviewDepth } from "./review-depth.js";
import { NO_TOKENS, type TokenUsage, addTokens, totalTokens } from "./token-usage.js";

/**
 * `bun run live:prbench`: Tesota's review answers SWE-PRBench's pull requests
 * (decision 023), one JSON file per task under
 * `live-runs/swe-prbench/answers/<label>/`, for the benchmark's own judge and
 * scorer (`evaluations/swe-prbench/score.py`). Each answer holds what Tesota
 * shows after refutation and what the reviewers raised before it. Tasks
 * already answered are skipped, so an interrupted run resumes.
 *
 * --data= (dataset directory), --split= (a file of PR records under the
 * dataset's `evals/`, as the harness takes through `--prs`; default eval_100,
 * the paper's 100 PRs), --config= (A, B or
 * C; default A), --max=, --label=, --depth=computed|standard|deep and
 * --model-reviewer=, --model-refuter= as `route:model`.
 */

const argument = (name: string): string | undefined =>
  process.argv.find((entry) => entry.startsWith(`--${name}=`))?.slice(name.length + 3);

const data = argument("data") ?? join("live-runs", "swe-prbench", "data", "dataset");
const split = argument("split") ?? "eval_100";
const config = `config_${argument("config") ?? "A"}`;
if (!["config_A", "config_B", "config_C"].includes(config)) throw new Error("Use --config=A, B or C.");
const depthMode = argument("depth") ?? "computed";
if (!["computed", "standard", "deep"].includes(depthMode)) throw new Error("Use --depth=computed, standard or deep.");
const chosen = readModelChoices();
const modelIds = { reviewer: argument("model-reviewer") ?? chosen.reviewer, refuter: argument("model-refuter") ?? chosen.refuter };
const label = argument("label") ?? `tesota-${modelIds.reviewer}-${modelIds.refuter}-${depthMode}`.replaceAll(":", "_");
const max = Number(argument("max") ?? "0");

interface PrRecord { readonly task_id?: string; readonly repo?: string; readonly pr_number?: number; readonly diff_patch?: string }
// The harness's own task naming: the record's task_id, or the repository's name and the PR number.
const taskIdOf = (pr: PrRecord): string => pr.task_id ?? `${(pr.repo ?? "").split("/").at(-1)}__${pr.pr_number ?? 0}`;
// The split is a JSON array of full PR records; the harness evaluates every record in the file it is given.
const records = JSON.parse(readFileSync(join(data, "evals", `${split}.json`), "utf8")) as PrRecord[];
const diffs = new Map(records.map((pr) => [taskIdOf(pr), pr.diff_patch ?? ""]));
const taskIds = [...diffs.keys()];
const selected = max > 0 ? taskIds.slice(0, max) : taskIds;

const models = { reviewer: await openModelTarget(modelIds.reviewer), refuter: await openModelTarget(modelIds.refuter) };
const out = join("live-runs", "swe-prbench", "answers", label);
mkdirSync(out, { recursive: true });
let answered = 0;
for (const taskId of selected) {
  const file = join(out, `${taskId}_${config}.json`);
  if (existsSync(file)) { answered += 1; continue; }
  const diff = diffs.get(taskId);
  if (diff === undefined) throw new Error(`No PR record for ${taskId}`);
  const context = (JSON.parse(readFileSync(join(data, "contexts", config, `${taskId}.json`), "utf8")) as { rendered: string }).rendered;
  // The benchmark's agents see the context and nothing else, so the checkout Tesota's reviewers could read is empty.
  const checkout = mkdtempSync(join(tmpdir(), "tesota-prbench-"));
  try {
    const input = prbenchReviewInput({ taskId, context, diff }, checkout);
    const decision = reviewDepth(input.snapshot, input.flags, input.checks);
    const deep = depthMode === "deep" || depthMode === "computed" && decision.depth === "deep";
    let usage: TokenUsage = NO_TOKENS;
    const onUsage = (used: TokenUsage): void => { usage = addTokens(usage, used); };
    const signal = new AbortController().signal;
    const started = Date.now();
    const reviewers = [createPiReviewer({ target: models.reviewer, onUsage }),
      ...(deep ? applicableLenses(checkout).map((lens) => createPiReviewer({ target: models.reviewer, onUsage, lens })) : [])];
    const reviews = attributeOrigins(await Promise.all(reviewers.map((reviewer) => reviewer.review(input, signal))), input.snapshot);
    const reviewed = Date.now();
    const tested = await refuteFindings({ target: models.refuter, onUsage }, input, reviews, signal);
    writeFileSync(file, `${JSON.stringify({ task_id: taskId, config_name: config, model: label, models: modelIds,
      depth: deep ? "deep" : "standard", raw_response: prbenchAnswer(tested), unrefuted_response: prbenchAnswer(reviews),
      reviewMs: reviewed - started, refuteMs: Date.now() - reviewed, tokens: totalTokens(usage), usage }, null, 2)}\n`);
    answered += 1;
    console.log(`${answered}/${selected.length} ${taskId}: ${deep ? "deep" : "standard"}, ` +
      `${Math.round((Date.now() - started) / 1000)} s, ${Math.round(totalTokens(usage) / 1000)}k tokens`);
  } finally { rmSync(checkout, { recursive: true, force: true }); }
}
console.log(`answered ${answered} of ${selected.length} in ${out}`);
