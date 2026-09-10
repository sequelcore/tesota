import { mkdir, mkdtemp, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { LIVE_CODEX_MODEL_ID, storedCodexModels } from "./integrations/pi-live.js";
import { runPiSession, type PiSessionResult } from "./integrations/pi.js";
import { serializeVerificationProbe, verificationProbePasses, verificationSourceIdentity,
  VERIFICATION_FIXTURE, VERIFICATION_FIXTURE_SOURCE } from "./integrations/pi-verification-evidence.js";
import { configuredOxlint } from "./verification/oxlint.js";
import { DurableVerificationEvidenceStore } from "./verification/evidence.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Tesota live verification experiment. --stored: reuse saved login, at most two model invocations and one fixed fixture verification. No source editing. --help is offline.");
} else if (args.length !== 1 || args[0] !== "--stored" || process.platform !== "win32") {
  console.error("Use --stored on Windows, or --help offline.");
  process.exitCode = 2;
} else {
  const cancel = new AbortController();
  const watchdog = setTimeout(() => { console.error("Verification experiment unconfirmed: watchdog expired."); process.exit(1); }, 249_000);
  try {
    if (await readFile(VERIFICATION_FIXTURE, "utf8") !== VERIFICATION_FIXTURE_SOURCE) throw new Error("Fixture changed");
    const identity = verificationSourceIdentity();
    await mkdir("experiments/codex/runs", { recursive: true });
    const directory = await mkdtemp("experiments/codex/runs/verification-");
    const record = await open(join(directory, "probe.json"), "wx", 0o600);
    const timestamp = new Date().toISOString();
    let result: PiSessionResult | null = null;
    let evidenceSaved = false;
    try {
      const models = await storedCodexModels(new CodexCredentials(), cancel.signal);
      const model = models.getModel("openai-codex", LIVE_CODEX_MODEL_ID);
      if (model?.api !== "openai-codex-responses") throw new Error("Locked model unavailable");
      result = await runPiSession({ scenario: "live_verification", model,
        stream: (requestedModel, context, options) => models.streamSimple(requestedModel, context, options),
        input: VERIFICATION_FIXTURE, check: configuredOxlint(process.cwd(), process.execPath) });
      if (result.issuedEvidence !== undefined) {
        await new DurableVerificationEvidenceStore(join(directory, "verification.json")).save(result.issuedEvidence);
        evidenceSaved = true;
      }
    } finally {
      try { await record.writeFile(serializeVerificationProbe(result, identity, timestamp, evidenceSaved), "utf8"); }
      finally { await record.close(); }
      console.log(`Evidence: ${join(directory, "probe.json")}`);
    }
    process.exitCode = result !== null && evidenceSaved && verificationProbePasses(result) ? 0 : 1;
  } catch {
    console.error("Verification experiment failed. Check saved login, fixed fixture and local evidence.");
    process.exitCode = 1;
  } finally { cancel.abort(); clearTimeout(watchdog); }
  process.exit(process.exitCode ?? 1);
}
