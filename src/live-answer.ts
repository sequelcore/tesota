import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { QUESTION_REPOSITORY, quantile } from "./agent-evaluation.js";
import { answerHeld, firstPass, reviewAnswer } from "./answer-check.js";
import { ANSWER_CASES, type FirstPassOutcome, type PremiseOutcome, type ReviewOutcome, isCheckable, scoreFirstPass, scorePremise,
  scoreReview, tally } from "./answer-evaluation.js";
import { openModelTarget } from "./integrations/model-session.js";
import { readModelChoices } from "./model-roles.js";
import { type TokenUsage, totalTokens } from "./token-usage.js";
import { runsAnswerCheck } from "./verification/answer-check-rule.js";
import { obligationOutcome } from "./verification/obligation-outcome.js";

/**
 * Run the answer check's evaluation live and write one JSON record under
 * live-runs/answer/. The first pass sees every registered turn; the full
 * check sees each turn with a registered verdict, in a fresh Git repository,
 * with the turn's recorded tool calls. Models default to the operator's roles.
 *
 *   bun run live:answer [--runs=N] [--stage=first-pass|review|all]
 *     [--model-triage=<id>] [--model-reviewer=<id>] [--model-refuter=<id>]
 */
const option = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const runs = Number(option("runs") ?? "2");
if (!Number.isInteger(runs) || runs < 1) throw new Error("Use --runs=N with N at least 1.");
const stage = option("stage") ?? "all";
if (!["first-pass", "review", "all"].includes(stage)) throw new Error("Use --stage=first-pass, review or all.");
const choices = readModelChoices();
const models = { triage: option("model-triage") ?? choices.triage, reviewer: option("model-reviewer") ?? choices.reviewer,
  refuter: option("model-refuter") ?? choices.refuter };

const root = mkdtempSync(join(tmpdir(), "tesota-answer-eval-"));
const git = (args: string[]): string => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
  { cwd: root, encoding: "utf8" }).stdout.trim();
for (const [path, text] of Object.entries({ ...QUESTION_REPOSITORY, "package.json": JSON.stringify({ type: "module" }) })) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}
git(["init", "-q"]);
git(["add", "-A"]);
git(["commit", "-q", "-m", "base"]);
const tree = git(["rev-parse", "HEAD^{tree}"]);

const firstPasses: { name: string; run: number; outcome: FirstPassOutcome; reason: string; probability?: number; durationMs: number }[] = [];
const reviews: { name: string; run: number; outcome: ReviewOutcome | PremiseOutcome; tokens: number; durationMs: number;
  statuses: string[] }[] = [];
const premises: PremiseOutcome[] = [];
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const answer of ANSWER_CASES) {
      if (stage !== "review") {
        const started = Date.now();
        const decision = await firstPass(models.triage, answer.requests, answer.reply, AbortSignal.timeout(5 * 60_000));
        const outcome = scoreFirstPass(answer, runsAnswerCheck(decision.decided, decision.checkable));
        firstPasses.push({ name: answer.name, run, outcome, reason: decision.reason, durationMs: Date.now() - started,
          ...(decision.probability === undefined ? {} : { probability: decision.probability }) });
        console.log(`run ${run} · first pass · ${answer.name}: ${outcome} (${decision.reason})`);
      }
      if (stage === "first-pass" || answer.holds === undefined && answer.operator === undefined) continue;
      let tokens = 0;
      const started = Date.now();
      const reports = await reviewAnswer(async (role) => ({ target: await openModelTarget(models[role]),
        onUsage: (usage: TokenUsage) => { tokens += totalTokens(usage); } }),
      { checkout: root, requests: answer.requests, snapshot: { base: tree, tree, changes: [], diff: "" }, checks: [], flags: [],
        response: answer.reply, toolCalls: answer.toolCalls }, AbortSignal.timeout(15 * 60_000));
      const main = reports.find((report) => report.status === "completed");
      const obligations = main?.status === "completed" ? main.obligations ?? [] : [];
      const premise = answer.operator === true ? scorePremise(main !== undefined,
        obligations.map((item) => obligationOutcome(item.status, item.standing ?? "untested"))) : undefined;
      if (premise !== undefined) premises.push(premise);
      const outcome = premise ?? scoreReview(answer.holds ?? true, main !== undefined, answerHeld(reports));
      const statuses = obligations.map((item) => `${item.status}/${item.standing ?? "untested"}`);
      reviews.push({ name: answer.name, run, outcome, tokens, durationMs: Date.now() - started, statuses });
      console.log(`run ${run} · review · ${answer.name}: ${outcome} (${statuses.join(", ") || "no verdict"}), ` +
        `${Math.round(tokens / 1000)}k tokens, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }

const record = { at: new Date().toISOString(), models, runs, stage,
  cases: { total: ANSWER_CASES.length, checkable: ANSWER_CASES.filter(isCheckable).length,
    withVerdict: ANSWER_CASES.filter((answer) => answer.holds !== undefined).length },
  firstPass: tally<FirstPassOutcome>(["right", "skipped checkable", "checked conversation"], firstPasses.map((entry) => entry.outcome)),
  premise: tally<PremiseOutcome>(["operator", "sent back", "cleared", "incomplete"], premises),
  review: { ...tally<ReviewOutcome>(["right", "missed", "false alarm", "incomplete"],
    reviews.filter((entry) => ANSWER_CASES.find((answer) => answer.name === entry.name)?.operator === undefined)
      .map((entry) => entry.outcome as ReviewOutcome)),
    tokens: reviews.reduce((sum, entry) => sum + entry.tokens, 0),
    medianMs: quantile(reviews.map((entry) => entry.durationMs), 0.5) },
  attempts: { firstPasses, reviews } };
mkdirSync(join("live-runs", "answer"), { recursive: true });
const file = join("live-runs", "answer", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`first pass ${JSON.stringify(record.firstPass)}\nreview ${JSON.stringify(record.review)}\n` +
  `premise ${JSON.stringify(record.premise)}\nrecorded ${file}`);
