import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { browserOnlyAuth, LIVE_LIMITS, liveProbePasses, runLiveCodexExperiment,
  type LiveCodexExperimentResult } from "./integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence } from "./integrations/pi-live-evidence.js";

if (process.argv.length === 3 && process.argv[2] === "--help") {
  console.log("Opt-in M3.1a: browser OAuth callback only; at most two model invocations. Writes docs/m31a-live-evidence.json. No retries.");
} else if (process.argv.length !== 2 || process.platform !== "win32") {
  console.error("Use live:codex without arguments on Windows, or --help offline.");
  process.exitCode = 2;
} else {
  const identity = liveSourceIdentity();
  // Reserve evidence before any login/inference. Existing evidence refuses another run.
  const evidenceFile = openSync("docs/m31a-live-evidence.json", "wx");
  const timestamp = new Date().toISOString();
  const cancellation = new AbortController();
  let result: LiveCodexExperimentResult | null = null;
  let exitCode = 1;
  const watchdog = setTimeout(() => {
    console.error("Live CLI watchdog expired; experiment unconfirmed.");
    process.exit(1);
  }, LIVE_LIMITS.loginMs + 2 * (LIVE_LIMITS.turnMs + LIVE_LIMITS.settlementMs) + 5_000);
  try {
    console.log("Complete OAuth in the browser. Manual authorization input is disabled.");
    const interaction = browserOnlyAuth((url) => {
      // Pi supplies the initial authorize URL, never a callback/code. No shell interpolation.
      const target = new URL(url);
      if (target.origin !== "https://auth.openai.com" || target.pathname !== "/oauth/authorize" ||
          target.searchParams.has("code") || target.searchParams.has("access_token")) {
        throw new Error("Unexpected OAuth browser route");
      }
      const browser = spawn("explorer.exe", [url], { windowsHide: true, stdio: "ignore" });
      browser.on("error", () => cancellation.abort());
      browser.unref();
    }, cancellation.signal);
    result = await runLiveCodexExperiment(interaction);
    exitCode = liveProbePasses(result.turn, false) && result.abortProbe !== null &&
      liveProbePasses(result.abortProbe, true) ? 0 : 1;
  } catch {
    console.error("Live experiment failed; secret-bearing error details suppressed.");
  } finally {
    cancellation.abort();
    clearTimeout(watchdog);
  }
  const evidence = serializeLiveEvidence(identity, timestamp, result);
  writeFileSync(evidenceFile, evidence, { encoding: "utf8" });
  closeSync(evidenceFile);
  console.log(evidence);
  // Pending Pi handles cannot extend CLI lifetime; this is not cancellation proof.
  process.exit(exitCode);
}
