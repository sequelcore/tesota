import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { browserOnlyAuth, LIVE_LIMITS, observeLiveBrowserLaunch, runLiveCodex,
  type LiveCodexRunResult } from "./integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence } from "./integrations/pi-live-evidence.js";

const args = process.argv.slice(2);
const mode = args[0] === "--auth-only" ? "auth_only" : args[0] === "--full-probe" ? "full_probe" : null;
if ((args.length === 1 && args[0] === "--help") ||
    (args.length === 2 && mode !== null && args[1] === "--help")) {
  console.log("Opt-in network authentication: browser OAuth callback only. --auth-only: ZERO model inference calls; no M3.1a probes. --full-probe: at most two model invocations. No retries. --help is offline.");
} else if (args.length !== 1 || mode === null || process.platform !== "win32") {
  console.error("Select --auth-only or --full-probe on Windows, or --help offline.");
  process.exitCode = 2;
} else {
  const identity = liveSourceIdentity();
  // Reserve evidence before any login/inference. Existing evidence refuses another run.
  const evidenceFile = openSync(mode === "auth_only" ? "docs/m31a-auth-only-evidence.json" : "docs/m31a-live-evidence.json", "wx");
  const timestamp = new Date().toISOString();
  const cancellation = new AbortController();
  let result: LiveCodexRunResult;
  let exitCode = 1;
  const watchdog = setTimeout(() => {
    console.error("Live CLI watchdog expired; experiment unconfirmed.");
    process.exit(1);
  }, LIVE_LIMITS.loginMs + (mode === "auth_only" ? 0 : 2 * (LIVE_LIMITS.turnMs + LIVE_LIMITS.settlementMs)) + 5_000);
  try {
    console.log(mode === "auth_only" ?
      "AUTH-ONLY: OAuth/network authentication; ZERO model inference calls; no M3.1a probes. Complete OAuth in the browser." :
      "FULL-PROBE: OAuth/network authentication followed by M3.1a model probes. Complete OAuth in the browser.");
    const interaction = browserOnlyAuth((url) => {
      // Pi supplies the initial authorize URL, never a callback/code. No shell interpolation.
      const target = new URL(url);
      if (target.origin !== "https://auth.openai.com" || target.pathname !== "/oauth/authorize" ||
          target.searchParams.has("code") || target.searchParams.has("access_token")) {
        throw new Error("Unexpected OAuth browser route");
      }
      observeLiveBrowserLaunch((onError) => {
        const browser = spawn("explorer.exe", [url], { windowsHide: true, stdio: "ignore" });
        browser.on("error", onError);
        browser.unref();
      }, cancellation);
    }, cancellation.signal);
    result = await runLiveCodex(mode, interaction);
    exitCode = result.disposition === "failed" ? 1 : 0;
  } catch {
    result = { mode, authentication: { outcome: "failed", oauthFailureCategory: "unknown" },
      experiment: null, inferenceAttempted: false, disposition: "failed" };
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
