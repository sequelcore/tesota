import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { hostProvider } from "./host-environment.js";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID } from "./integrations/pi-live.js";
import { refuteFindings } from "./integrations/pi-refuter.js";
import { createPiReviewer } from "./integrations/pi-reviewer.js";
import type { ReviewReport } from "./review.js";
import { EVALUATION_CASES, scoreCase, type CaseScore } from "./review-evaluation.js";
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
    unsettled: sum("unsettled"), refuted: sum("refuted") };
}

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
    const review = await createPiReviewer({ modelRuntime: runtime, model }).review(input, signal);
    const reviewed = Date.now();
    const tested = await refuteFindings({ modelRuntime: runtime, model }, input, [review], signal);
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
    raw.push(scoreCase(testCase, [review], "raw"));
    refuted.push(scoreCase(testCase, tested, "refuted"));
    cases.push({ name: testCase.name, checks: checks.map((check) => check.outcome), reviewMs: reviewed - started,
      refuteMs: done - reviewed, raw: raw.at(-1), refuted: refuted.at(-1), plantedFalseClaim: planted, reports: tested });
    console.log(`${testCase.name}: raw ${JSON.stringify(raw.at(-1))} | refuted ${JSON.stringify(refuted.at(-1))} | ` +
      `review ${Math.round((reviewed - started) / 1000)} s, refuter ${Math.round((done - reviewed) / 1000)} s` +
      (planted === undefined ? "" : ` | planted false claim: ${planted}`));
  }
} finally { rmSync(root, { recursive: true, force: true }); }
const record = { at: new Date().toISOString(), model: LIVE_CODEX_MODEL_ID, raw: totals(raw), refuted: totals(refuted),
  plantedFalseClaims: { total: plantedResults.length, refuted: plantedResults.filter((result) => result === "refuted").length,
    confirmed: plantedResults.filter((result) => result === "confirmed").length }, cases };
mkdirSync(join("live-runs", "review"), { recursive: true });
const file = join("live-runs", "review", `${record.at.replaceAll(":", "-")}.json`);
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`raw ${JSON.stringify(record.raw)}\nrefuted ${JSON.stringify(record.refuted)}\n` +
  `planted false claims ${JSON.stringify(record.plantedFalseClaims)}\nrecorded ${file}`);
