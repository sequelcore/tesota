import { mock } from "bun:test";
import { CodexCredentials } from "../../dist/integrations/codex-credentials.js";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

const directory = process.env["TESOTA_TEST_AUTH_DIRECTORY"];
if (!directory) throw new Error("Synthetic storage required");
const createProvider = openaiCodexProvider;
mock.module("../../dist/integrations/codex-credentials.js", () => ({
  CodexCredentials: class extends CodexCredentials { constructor() { super(directory); } },
}));
mock.module("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => {
    const provider = createProvider();
    provider.auth.oauth.login = async () => {
      return { type: "oauth", access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3_600_000 };
    };
    return provider;
  },
}));
for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, "isTTY", { value: true });
globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
