import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hostProvider } from "./host-environment.js";
import { type ModelAccess, openModelTarget } from "./integrations/model-session.js";
import { readModelChoices } from "./model-roles.js";
import { refuteFindings } from "./integrations/pi-refuter.js";
import { applicableLenses, createPiReviewer } from "./integrations/pi-reviewer.js";
import { attributeOrigins } from "./finding-origin.js";
import { reviewDepth } from "./review-depth.js";
import type { ReviewReport } from "./review.js";
import { ENVIRONMENT_CASES, EVALUATION_CASES, PREMISE_CASES, PROOF_REVIEW_CASES, SCOPE_CASES, defectDispositions, scoreCase,
  type CaseScore, type EvaluationCase } from "./review-evaluation.js";
import { proofGuarantees } from "./proof-guarantees.js";
import { runLemmaScriptVerifier } from "./verification/lemmascript-verifier.js";
import { validateFixes } from "./integrations/pi-fix-validator.js";
import type { ReviewInput } from "./review.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import { flagVerificationChanges } from "./verification-changes.js";
import { Workspace } from "./workspace.js";
import { runChecks } from "./workspace-checks.js";
import { NO_TOKENS, type TokenUsage, addTokens, totalTokens } from "./token-usage.js";

/**
 * Run the review evaluation set live (decision 016) and write one JSON record
 * under live-runs/review/. The reviewer runs once per case; its findings are
 * scored as raw and again after the refuter, so the two differ only by it.
 */
function write(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function totals(scores: readonly CaseScore[]): Record<string, number> {
  const sum = (key: keyof Omit<CaseScore, "name">): number => scores.reduce((total, score) => total + score[key], 0);
  return { found: sum("found"), seeded: sum("seeded"), falsePositives: sum("falsePositives"),
    unsettled: sum("unsettled"), refuted: sum("refuted"), duplicates: sum("duplicates"), shown: sum("shown"),
    unknownOrigin: sum("unknownOrigin"), defectsUnknown: sum("defectsUnknown"), extras: sum("extras"),
    extrasMarked: sum("extrasMarked"), extrasSentBack: sum("extrasSentBack"), premise: sum("premise"),
    premiseMarked: sum("premiseMarked"), premiseSentBack: sum("premiseSentBack"), premiseCaseSentBack: sum("premiseCaseSentBack"),
    blockedSentBack: sum("blockedSentBack"), blockedToOperator: sum("blockedToOperator") };
}

/**
 * Send back the confirmed findings that match the planted defect, then judge
 * a correction that fixes it and one that does not: the validator should
 * resolve the first and not the second, and the review of the real fix should
 * confirm nothing new.
 */
/** The model access for each role in this run. */
interface RoleAccess {
  readonly reviewer: ModelAccess;
  readonly refuter: ModelAccess;
  readonly validator: ModelAccess;
}

async function measureCorrections(ai: RoleAccess,
  testCase: EvaluationCase, workspace: Workspace, snapshot: WorkspaceSnapshot,
  input: ReviewInput, tested: readonly ReviewReport[], signal: AbortSignal): Promise<unknown> {
  if (testCase.corrections === undefined) return undefined;
  const sentBack = tested.flatMap((report) => report.status === "completed" ? report.findings : [])
    .filter((finding) => finding.standing === "confirmed" && finding.origin === "introduced" &&
      testCase.defects.some((defect) => defect.paths.some((path) => finding.path?.replaceAll("\\", "/").endsWith(path) === true)));
  if (sentBack.length === 0) return { skipped: "no confirmed finding matched the planted defect" };
  const results: Record<string, unknown> = {};
  for (const [variant, files] of Object.entries(testCase.corrections)) {
    write(workspace.checkout, testCase.candidate);
    write(workspace.checkout, files);
    const corrected = workspace.snapshot();
    const scope = { ...corrected, base: snapshot.tree, ...workspace.compare(snapshot.tree, corrected.tree) };
    const correctionInput: ReviewInput = { ...input, snapshot: scope, correction: { sentBack } };
    const validation = await validateFixes(ai.validator, correctionInput, sentBack, signal);
    const delta = await refuteFindings(ai.refuter, correctionInput,
      attributeOrigins([await createPiReviewer(ai.reviewer).review(correctionInput, signal)], corrected), signal);
    const remaining = validation.status === "completed" ? validation.findings : [];
    results[variant] = { sentBack: sentBack.length, resolved: sentBack.length - remaining.length,
      unresolved: remaining.filter((finding) => finding.standing === "confirmed").length,
      newConfirmed: delta.flatMap((report) => report.status === "completed" ? report.findings : [])
        .filter((finding) => finding.standing === "confirmed" && finding.origin === "introduced").length,
      validation, delta };
    console.log(`  ${variant} correction: ${JSON.stringify({ ...results[variant] as object, validation: undefined, delta: undefined })}`);
  }
  write(workspace.checkout, testCase.candidate);
  return results;
}

// --depth=computed (default) chooses depth as Tesota does; standard and deep force one for comparison.
const depthArgument = process.argv.find((argument) => argument.startsWith("--depth="))?.slice("--depth=".length) ?? "computed";
if (!["computed", "standard", "deep"].includes(depthArgument)) throw new Error("Use --depth=computed, standard or deep.");
const depthMode = depthArgument as "computed" | "standard" | "deep";
const skipCorrections = process.argv.includes("--skip-corrections");
// --set=core (default) runs the eight core cases, scope the work-beyond-the-request cases (issue #165), premise the
// changes acting on a false premise, environment the requests a check blocks for a reason outside the change (#224),
// all every set.
const setArgument = process.argv.find((argument) => argument.startsWith("--set="))?.slice("--set=".length) ?? "core";
const sets: Record<string, readonly EvaluationCase[]> = { core: EVALUATION_CASES, scope: SCOPE_CASES, premise: PREMISE_CASES,
  environment: ENVIRONMENT_CASES, proofs: PROOF_REVIEW_CASES,
  all: [...EVALUATION_CASES, ...SCOPE_CASES, ...PREMISE_CASES, ...ENVIRONMENT_CASES] };
const selected = sets[setArgument];
if (selected === undefined) throw new Error("Use --set=core, scope, premise, environment, proofs or all.");
// The proofs set runs its TypeScript tests and LemmaScript with Dafny, and records which changed lines a proof covers
// and where the findings on its planted defects went (docs/design/proofs.md).

// --model-reviewer=, --model-refuter= and --model-validator= compare route:model choices; otherwise the operator's apply.
const chosen = readModelChoices();
const modelIds = Object.fromEntries((["reviewer", "refuter", "validator"] as const).map((role) => [role,
  process.argv.find((argument) => argument.startsWith(`--model-${role}=`))?.slice(`--model-${role}=`.length) ?? chosen[role]])) as
  Record<"reviewer" | "refuter" | "validator", string>;
const models = { reviewer: await openModelTarget(modelIds.reviewer), refuter: await openModelTarget(modelIds.refuter),
  validator: await openModelTarget(modelIds.validator) };
const root = mkdtempSync(join(tmpdir(), "tesota-review-eval-"));
const cases: unknown[] = [];
const plantedResults: string[] = [];
const raw: CaseScore[] = [];
const refuted: CaseScore[] = [];
const notMeasured: { name: string; reason: string }[] = [];
try {
  for (const testCase of selected) {
    const source = join(root, testCase.name.replaceAll(" ", "-"));
    mkdirSync(source, { recursive: true });
    const git = (args: string[]): void => { spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: source }); };
    git(["init", "-q"]);
    write(source, { ...testCase.base, "package.json": JSON.stringify({ type: "module" }) });
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    const workspace = await Workspace.create(source, join(root, "workspaces"), { sourcesRoot: join(dirname(join(root, "workspaces")), "sources") });
    await workspace.recordRequest(testCase.request);
    write(workspace.checkout, testCase.candidate);
    const snapshot = workspace.snapshot();
    const signal = new AbortController().signal;
    const proofs = setArgument === "proofs";
    const read = (revision: string, path: string): string | undefined => workspace.contentAt(revision, path);
    const checks = [...await runChecks(await hostProvider.prepare(workspace.checkout), workspace, snapshot,
      [{ command: `node --test "src/**/*.test.${proofs ? "ts" : "js"}"`, reports: [] }], signal),
      ...proofs ? await runLemmaScriptVerifier(snapshot, read, signal) : []];
    const covered = proofs ? proofGuarantees(snapshot, checks, [], read).covered ?? [] : [];
    const input = { checkout: workspace.checkout, requests: await workspace.requests(), snapshot, checks,
      flags: flagVerificationChanges(snapshot, read) };
    const started = Date.now();
    const decision = reviewDepth(snapshot, input.flags, checks);
    const deep = depthMode === "deep" || depthMode === "computed" && decision.depth === "deep";
    // Tokens of the reviewers and the refuter, as the review step counts them (decision 018).
    let usage = NO_TOKENS;
    const onUsage = (used: TokenUsage): void => { usage = addTokens(usage, used); };
    const ai: RoleAccess = { reviewer: { target: models.reviewer, onUsage },
      refuter: { target: models.refuter, onUsage },
      validator: { target: models.validator, onUsage } };
    const reviews = attributeOrigins(await Promise.all([createPiReviewer(ai.reviewer),
      ...(deep ? applicableLenses(workspace.checkout).map((lens) => createPiReviewer({ ...ai.reviewer, lens })) : [])]
      .map((reviewer) => reviewer.review(input, signal))), snapshot);
    const reviewed = Date.now();
    // A case where no reviewer finished measures the environment, not the review: record it as not measured, never
    // as zeros, and go on, so one failed case does not lose the others.
    const failed = reviews.find((report) => report.status === "incomplete");
    if (failed !== undefined && reviews.every((report) => report.status === "incomplete")) {
      notMeasured.push({ name: testCase.name, reason: failed.reason });
      cases.push({ name: testCase.name, notMeasured: failed.reason });
      console.log(`${testCase.name}: not measured, every reviewer failed: ${failed.reason}`);
      continue;
    }
    const tested = await refuteFindings(ai.refuter, input, reviews, signal);
    const done = Date.now();
    const reviewUsage = usage;
    const reviewTokens = totalTokens(reviewUsage);
    // Measure the refuter directly: a planted false finding it should kill.
    let planted: string | undefined;
    if (testCase.falseClaim !== undefined) {
      const claim: ReviewReport = { reviewer: "Planted", tree: snapshot.tree, status: "completed", summary: "",
        findings: [{ severity: "high", disposition: "fixable", origin: "introduced", ...testCase.falseClaim }] };
      const [judged] = await refuteFindings({ target: models.refuter }, input, [claim], signal);
      planted = judged?.status === "completed" ? judged.findings[0]?.standing : "unsettled";
      plantedResults.push(planted ?? "unsettled");
    }
    raw.push(scoreCase(testCase, reviews, "raw"));
    refuted.push(scoreCase(testCase, tested, "refuted"));
    const corrections = skipCorrections ? undefined : await measureCorrections(ai, testCase, workspace, snapshot, input, tested, signal);
    cases.push({ name: testCase.name, depth: deep ? "deep" : "standard", depthReasons: decision.reasons, checks: checks.map((check) => check.outcome), reviewMs: reviewed - started, reviewTokens, reviewUsage,
      refuteMs: done - reviewed, raw: raw.at(-1), refuted: refuted.at(-1), plantedFalseClaim: planted, corrections, reports: tested,
      ...proofs ? { covered, defectDispositions: defectDispositions(testCase, tested) } : {} });
    console.log(`${testCase.name}: raw ${JSON.stringify(raw.at(-1))} | refuted ${JSON.stringify(refuted.at(-1))} | ` +
      `review ${Math.round((reviewed - started) / 1000)} s, refuter ${Math.round((done - reviewed) / 1000)} s, ` +
      `${Math.round(reviewTokens / 1000)}k tokens (${Math.round(reviewUsage.cacheRead / 1000)}k cached)` +
      (planted === undefined ? "" : ` | planted false claim: ${planted}`) +
      (proofs ? ` | covered ${covered.map((entry) => `${entry.path}:${entry.lines.join(",")}`).join(" ") || "none"}` +
        ` | defect findings ${defectDispositions(testCase, tested).join(",") || "none"}` : ""));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
const record = { at: new Date().toISOString(), models: modelIds, depthMode, set: setArgument,
  raw: totals(raw), refuted: totals(refuted),
  plantedFalseClaims: { total: plantedResults.length, refuted: plantedResults.filter((result) => result === "refuted").length,
    confirmed: plantedResults.filter((result) => result === "confirmed").length }, notMeasured, cases };
mkdirSync(join("live-runs", "review"), { recursive: true });
const file = join("live-runs", "review", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`raw ${JSON.stringify(record.raw)}\nrefuted ${JSON.stringify(record.refuted)}\n` +
  `planted false claims ${JSON.stringify(record.plantedFalseClaims)}\n` +
  (notMeasured.length === 0 ? "" : `not measured: ${notMeasured.map((entry) => entry.name).join(", ")}\n`) + `recorded ${file}`);
