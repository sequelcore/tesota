import { createModels } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { CodexCredentials } from "./integrations/codex-credentials.js";
import { deviceCodeAuth, deviceCodeTerminalRenderer, runLiveCodex } from "./integrations/pi-live.js";

export async function runAuthCommand(action: string): Promise<number> {
  if (!["login", "status", "logout"].includes(action)) {
    console.error("Usage: tesota auth <login|status|logout>");
    return 2;
  }
  const credentials = new CodexCredentials();
  try {
    if (action === "status") {
      const present = (await credentials.list()).length !== 0;
      console.log(present ? "Codex: saved login available. Model access is checked when used." : "Codex: logged out. Run tesota auth login.");
      return 0;
    }
    if (action === "logout") {
      const models = createModels({ credentials });
      models.setProvider(openaiCodexProvider());
      await models.logout("openai-codex");
      console.log("Codex: local Tesota credentials removed.");
      return 0;
    }
    if ((await credentials.list()).length !== 0) {
      console.log("Codex: already logged in. To change accounts, run tesota auth logout first.");
      return 0;
    }
    const cancel = new AbortController();
    const watchdog = setTimeout(() => process.exit(1), 185_000);
    try {
      const result = await runLiveCodex("auth_only", deviceCodeAuth(deviceCodeTerminalRenderer(), cancel.signal), credentials);
      if (result.disposition !== "succeeded") throw new Error("Login did not complete");
      console.log("Codex: login saved for future Tesota runs.");
      return 0;
    } finally { cancel.abort(); clearTimeout(watchdog); }
  } catch {
    console.error("Codex authentication operation failed. Credentials were not printed. Check private storage or retry login after resolving the failure.");
    return 1;
  }
}
