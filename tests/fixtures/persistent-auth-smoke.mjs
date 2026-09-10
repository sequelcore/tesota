import { mock } from "bun:test";
import { CodexCredentials } from "../../dist/integrations/codex-credentials.js";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";

const directory = process.env["TESOTA_TEST_AUTH_DIRECTORY"];
if (!directory) throw new Error("Synthetic storage required");
const createProvider = openaiCodexProvider;
mock.module("../../dist/integrations/codex-credentials.js", () => ({
  CodexCredentials: class extends CodexCredentials { constructor() { super(directory); } },
}));
mock.module("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => {
    const provider = createProvider();
    let count = 0;
    provider.auth.oauth.login = async () => {
      if (process.argv.includes("--stored")) throw new Error("LOGIN_FORBIDDEN");
      return { type: "oauth", access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3_600_000 };
    };
    provider.streamSimple = (_model, _context, options) => {
      if (options?.apiKey !== "SYNTHETIC_ACCESS") throw new Error("Stored credential was not applied");
      const events = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("TESOTA_CODEX_OK");
      if (++count === 1) { events.push({ type: "done", reason: "stop", message }); events.end(message); }
      else {
        options.signal.addEventListener("abort", () => {
          const aborted = { ...message, stopReason: "aborted" };
          events.push({ type: "error", reason: "aborted", error: aborted }); events.end(aborted);
        }, { once: true });
        events.push({ type: "start", partial: message });
        events.push({ type: "text_delta", contentIndex: 0, delta: "test", partial: message });
      }
      return events;
    };
    return provider;
  },
}));
if (!process.argv.includes("--stored")) {
  for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, "isTTY", { value: true });
}
globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
