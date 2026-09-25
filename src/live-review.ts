import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { hostProvider } from "./host-environment.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID } from "./integrations/pi-live.js";
import { refuteFindings } from "./integrations/pi-refuter.js";
import { applicableLenses, createPiReviewer } from "./integrations/pi-reviewer.js";
import { reviewDepth } from "./review-depth.js";
import type { ReviewReport } from "./review.js";
import { EVALUATION_CASES, scoreCase, type CaseScore, type EvaluationCase } from "./review-evaluation.js";
import { validateFixes } from "./integrations/pi-fix-validator.js";
import type { ReviewInput } from "./review.js";
import type { WorkspaceSnapshot } from "./workspace.js";
import { flagVerificationChanges } from "./verification-changes.js";
import { Workspace } from "./workspace.js";
import { runChecks } from "./workspace-checks.js";

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
    unsettled: sum("unsettled"), refuted: sum("refuted"), duplicates: sum("duplicates"), shown: sum("shown") };
}

/**
 * Send back the confirmed findings that match the planted defect, then judge
 * a correction that fixes it and one that does not: the validator should
 * resolve the first and not the second, and the review of the real fix should
 * confirm nothing new.
 */
async function measureCorrections(ai: { readonly modelRuntime: ModelRuntime; readonly model: Model<Api> },
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
    const validation = await validateFixes(ai, correctionInput, sentBack, signal);
    const delta = await refuteFindings(ai, correctionInput, [await createPiReviewer(ai).review(correctionInput, signal)], signal);
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

const runtime = await ModelRuntime.create({ credentials: new CodexCredentials(), refreshOnCreate: false, allowModelNetwork: false });
const model = runtime.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
if (model === undefined) throw new Error("The Codex model is unavailable. Run tesota auth login.");
const root = mkdtempSync(join(tmpdir(), "tesota-review-eval-"));
const cases: unknown[] = [];
const plantedResults: string[] = [];
const raw: CaseScore[] = [];
const refuted: CaseScore[] = [];
try {
  for (const testCase of EVALUATION_CASES) {
    const source = join(root, testCase.name.replaceAll(" ", "-"));
    mkdirSync(source, { recursive: true });
    const git = (args: string[]): void => { spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: source }); };
    git(["init", "-q"]);
    write(source, { ...testCase.base, "package.json": JSON.stringify({ type: "module" }) });
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "base"]);
    const workspace = await Workspace.create(source, join(root, "workspaces"));
    await workspace.recordRequest(testCase.request);
    write(workspace.checkout, testCase.candidate);
    const snapshot = workspace.snapshot();
    const signal = new AbortController().signal;
    const checks = await runChecks(await hostProvider.prepare(workspace.checkout), workspace, snapshot,
      ["node --test \"src/**/*.test.js\""], signal);
    const input = { checkout: workspace.checkout, requests: await workspace.requests(), snapshot, checks,
      flags: flagVerificationChanges(snapshot, (revision, path) => workspace.contentAt(revision, path)) };
    const started = Date.now();
    const decision = reviewDepth(snapshot, input.flags, checks);
    const deep = depthMode === "deep" || depthMode === "computed" && decision.depth === "deep";
    const ai = { modelRuntime: runtime, model };
    const reviews = await Promise.all([createPiReviewer(ai),
      ...(deep ? applicableLenses(workspace.checkout).map((lens) => createPiReviewer({ ...ai, lens })) : [])]
      .map((reviewer) => reviewer.review(input, signal)));
    const reviewed = Date.now();
    // A run where no reviewer finished measures the environment, not the review: stop instead of recording zeros.
    const failed = reviews.find((report) => report.status === "incomplete");
    if (failed !== undefined && reviews.every((report) => report.status === "incomplete")) {
      throw new Error(`Every reviewer failed on "${testCase.name}", so nothing was measured: ${failed.reason}`);
    }
    const tested = await refuteFindings(ai, input, reviews, signal);
    const done = Date.now();
    // Measure the refuter directly: a planted false finding it should kill.
    let planted: string | undefined;
    if (testCase.falseClaim !== undefined) {
      const claim: ReviewReport = { reviewer: "Planted", tree: snapshot.tree, status: "completed", summary: "",
        findings: [{ severity: "high", disposition: "fixable", origin: "introduced", ...testCase.falseClaim }] };
      const [judged] = await refuteFindings({ modelRuntime: runtime, model }, input, [claim], signal);
      planted = judged?.status === "completed" ? judged.findings[0]?.standing : "unsettled";
      plantedResults.push(planted ?? "unsettled");
    }
    raw.push(scoreCase(testCase, reviews, "raw"));
    refuted.push(scoreCase(testCase, tested, "refuted"));
    const corrections = skipCorrections ? undefined : await measureCorrections(ai, testCase, workspace, snapshot, input, tested, signal);
    cases.push({ name: testCase.name, depth: deep ? "deep" : "standard", depthReasons: decision.reasons, checks: checks.map((check) => check.outcome), reviewMs: reviewed - started,
      refuteMs: done - reviewed, raw: raw.at(-1), refuted: refuted.at(-1), plantedFalseClaim: planted, corrections, reports: tested });
    console.log(`${testCase.name}: raw ${JSON.stringify(raw.at(-1))} | refuted ${JSON.stringify(refuted.at(-1))} | ` +
      `review ${Math.round((reviewed - started) / 1000)} s, refuter ${Math.round((done - reviewed) / 1000)} s` +
      (planted === undefined ? "" : ` | planted false claim: ${planted}`));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
const record = { at: new Date().toISOString(), model: LIVE_CODEX_MODEL_ID, depthMode, raw: totals(raw), refuted: totals(refuted),
  plantedFalseClaims: { total: plantedResults.length, refuted: plantedResults.filter((result) => result === "refuted").length,
    confirmed: plantedResults.filter((result) => result === "confirmed").length }, cases };
mkdirSync(join("live-runs", "review"), { recursive: true });
const file = join("live-runs", "review", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`raw ${JSON.stringify(record.raw)}\nrefuted ${JSON.stringify(record.refuted)}\n` +
  `planted false claims ${JSON.stringify(record.plantedFalseClaims)}\nrecorded ${file}`);
