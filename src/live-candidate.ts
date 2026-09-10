import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { runPiSession, type PiSessionResult } from "./integrations/pi.js";
import { candidateProbePasses, serializeCandidateProbe, verificationSourceIdentity,
  type CandidateAssessment } from "./integrations/pi-verification-evidence.js";
import { configuredOxlint } from "./verification/oxlint.js";
import { DurableVerificationEvidenceStore } from "./verification/evidence.js";
import { CANDIDATE_SOURCE, VerificationCandidate } from "./verification/candidate.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Tesota candidate correction experiment. --stored: four model invocations, two checks and one bounded edit in a fresh candidate directory. No promotion. --help is offline.");
} else if (args.length !== 1 || args[0] !== "--stored" || process.platform !== "win32") {
  console.error("Use --stored on Windows, or --help offline.");
  process.exitCode = 2;
} else {
  const cancel = new AbortController();
  const watchdog = setTimeout(() => { console.error("Candidate experiment unconfirmed: watchdog expired."); process.exit(1); }, 285_000);
  let candidate: VerificationCandidate | undefined;
  try {
    const identity = verificationSourceIdentity("candidate");
    await mkdir("experiments/codex/runs", { recursive: true });
    const directory = await mkdtemp("experiments/codex/runs/correction-");
    candidate = await VerificationCandidate.create(directory, configuredOxlint(process.cwd(), process.execPath));
    await writeFile(join(directory, "before.ts"), CANDIDATE_SOURCE, { flag: "wx", mode: 0o600 });
    const record = await open(join(directory, "probe.json"), "wx", 0o600);
    const timestamp = new Date().toISOString();
    let result: PiSessionResult | null = null;
    let assessment: CandidateAssessment | null = null;
    let evidenceSaved = false;
    let reviewSaved = false;
    try {
      const models = await storedCodexModels(new CodexCredentials(), cancel.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("Locked model unavailable");
      result = await runPiSession({ scenario: "candidate_correction", candidate, model, input: "candidate.ts",
        check: configuredOxlint(process.cwd(), process.execPath),
        stream: (requested, context, options) => models.streamSimple(requested, context, options) });
      for (const [index, check] of candidate.checks.entries()) {
        if (check.status !== "execution_failed") await new DurableVerificationEvidenceStore(join(directory, `check-${index + 1}.json`)).save(check);
      }
      const [before, after] = candidate.checks;
      if (before !== undefined && after !== undefined) {
        assessment = { prior: await candidate.applicability(before), current: await candidate.applicability(after) };
        evidenceSaved = before.status !== "execution_failed" && after.status !== "execution_failed";
      }
      // Review artifact is local and may contain untrusted model-authored source.
      const diff = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "before.ts", "candidate/candidate.ts"],
        { cwd: directory, windowsHide: true, encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 });
      if (diff.error !== undefined || diff.status !== 0 && diff.status !== 1) throw new Error("Candidate diff unavailable");
      await writeFile(join(directory, "candidate.diff"), diff.stdout, { flag: "wx", mode: 0o600 });
      reviewSaved = true;
    } finally {
      candidate.close();
      try { await record.writeFile(serializeCandidateProbe(result, candidate, assessment, identity, timestamp, evidenceSaved && reviewSaved), "utf8"); }
      finally { await record.close(); }
      console.log(`Evidence and candidate diff: ${directory}`);
    }
    process.exitCode = result !== null && assessment !== null && evidenceSaved && reviewSaved && candidateProbePasses(result, candidate, assessment) ? 0 : 1;
  } catch {
    console.error("Candidate experiment failed; inspect its retained local evidence. No promotion occurred.");
    process.exitCode = 1;
  } finally { candidate?.close(); cancel.abort(); clearTimeout(watchdog); }
  process.exit(process.exitCode ?? 1);
}
