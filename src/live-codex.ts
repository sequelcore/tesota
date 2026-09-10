import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { browserOnlyAuth, deviceCodeAuth, deviceCodeTerminalRenderer, LIVE_LIMITS, observeLiveBrowserLaunch, runLiveCodex,
  type LiveCodexRunResult } from "./integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence } from "./integrations/pi-live-evidence.js";

const args = process.argv.slice(2);
const mode = args[0] === "--auth-only" ? "auth_only" : args[0] === "--full-probe" ? "full_probe" : null;
const authenticationMethod = args[1] === "--device-code" ? "device_code" : "browser";
const validMode = mode === "auth_only" ? authenticationMethod === "device_code" : mode === "full_probe";
const modeArgs = authenticationMethod === "device_code" ? 2 : 1;
if ((args.length === 1 && args[0] === "--help") ||
    (validMode && args.length === modeArgs + 1 && args[modeArgs] === "--help")) {
  console.log("Tesota Codex experiment. Opt-in network authentication. --auth-only --device-code: device-code login in an interactive, unrecorded terminal; ZERO model inference calls; no model probes. --full-probe --device-code: device-code authentication AND up to two model invocations in an interactive, unrecorded terminal. --full-probe: browser OAuth callback only, at most two model invocations. No retries. --help is offline.");
} else if (args.length !== modeArgs || !validMode || mode === null || process.platform !== "win32") {
  console.error("Select --auth-only --device-code or --full-probe [--device-code] on Windows, or --help offline.");
  process.exitCode = 2;
} else if (authenticationMethod === "device_code" &&
    (process.stdin.isTTY !== true || process.stdout.isTTY !== true || process.stderr.isTTY !== true)) {
  console.error("Device-code login requires an interactive, unrecorded terminal; captured execution is disabled.");
  process.exitCode = 2;
} else {
  const identity = liveSourceIdentity();
  // Reserve evidence before any login/inference. Existing evidence refuses another run.
  const evidenceFile = openSync(mode === "auth_only" ? "experiments/codex/evidence/device-auth.json" :
    authenticationMethod === "device_code" ? "experiments/codex/evidence/device-probe.json" : "experiments/codex/evidence/browser-probe.json", "wx");
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
      "AUTH-ONLY: device-code OAuth/network authentication; ZERO model inference calls; no model probes. Use an unrecorded terminal; enter the code only on the official website, never into Tesota or an agent." :
      authenticationMethod === "device_code" ?
      "FULL-PROBE: device-code OAuth/network authentication AND up to two model invocations. Use an unrecorded terminal; enter the code only on the official website, never into Tesota or an agent." :
      "FULL-PROBE: OAuth/network authentication followed by model probes. Complete OAuth in the browser.");
    const interaction = authenticationMethod === "device_code" ?
      deviceCodeAuth(deviceCodeTerminalRenderer(), cancellation.signal) : browserOnlyAuth((url) => {
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
    result = { mode, authenticationMethod, authentication: { outcome: "failed", oauthFailureCategory: "unknown" },
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
