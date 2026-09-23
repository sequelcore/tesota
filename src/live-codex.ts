import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { deviceCodeAuth, deviceCodeTerminalRenderer, runLiveCodex, type LiveAuthInteraction,
  type LiveCodexRunResult } from "./integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence } from "./integrations/pi-live-evidence.js";

const args = process.argv.slice(2);
const mode = args[0] === "--auth-only" ? "auth_only" : args[0] === "--full-probe" ? "full_probe" : null;
const method = args[1] === "--stored" ? "stored" : args[1] === "--device-code" ? "device_code" : null;
const valid = mode !== null && method !== null && (mode === "full_probe" || method === "device_code");
if ((args.length === 1 && args[0] === "--help") || (valid && args.length === 3 && args[2] === "--help")) {
  console.log("Tesota Codex experiment. --full-probe --stored reuses saved login for up to two model invocations. --full-probe --device-code performs network authentication AND up to two model invocations. --auth-only --device-code: ZERO model inference calls; no model probes. Device login requires an interactive terminal. No retries. --help is offline.");
} else if (!valid || args.length !== 2 || process.platform !== "win32") {
  console.error("Select --auth-only --device-code or --full-probe <--stored|--device-code> on Windows, or --help offline.");
  process.exitCode = 2;
} else if (method === "device_code" &&
  (process.stdin.isTTY !== true || process.stdout.isTTY !== true || process.stderr.isTTY !== true)) {
  console.error("Device-code login requires an interactive, unrecorded terminal; captured execution is disabled.");
  process.exitCode = 2;
} else {
  const cancel = new AbortController();
  const watchdog = setTimeout(() => { console.error("Codex experiment unconfirmed: watchdog expired."); process.exit(1); }, mode === "auth_only" ? 185_000 : 249_000);
  try {
    const credentials = method === "stored" ? new CodexCredentials() : undefined;
    if (credentials !== undefined && (await credentials.list()).length === 0) {
      throw new Error("No saved login");
    }
    const identity = liveSourceIdentity();
    const directory = "experiments/codex/runs";
    mkdirSync(directory, { recursive: true });
    const destination = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`);
    const file = openSync(destination, "wx", 0o600);
    const timestamp = new Date().toISOString();
    try {
      console.log(method === "stored" ? "Using saved Codex login; up to two model invocations." :
        mode === "auth_only" ? "ZERO model inference calls; device-code authentication only." :
        "device-code OAuth/network authentication AND up to two model invocations");
      const interaction: LiveAuthInteraction = method === "stored" ? {
        authenticationMethod: "stored", signal: cancel.signal,
        prompt: async () => { throw new Error("Stored login cannot prompt"); },
        notify: () => { throw new Error("Stored login cannot notify"); },
      } : deviceCodeAuth(deviceCodeTerminalRenderer(), cancel.signal);
      const result: LiveCodexRunResult = await runLiveCodex(mode, interaction, credentials);
      writeFileSync(file, serializeLiveEvidence(identity, timestamp, result), { encoding: "utf8" });
      console.log(`Evidence: ${destination}`);
      process.exitCode = result.disposition === "failed" ? 1 : 0;
    } finally { closeSync(file); }
  } catch {
    console.error("Codex experiment failed. Check tesota auth status and private storage; run tesota auth login if logged out.");
    process.exitCode = 1;
  } finally { cancel.abort(); clearTimeout(watchdog); }
  process.exit(process.exitCode ?? 1);
}
