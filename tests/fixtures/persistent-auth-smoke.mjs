import { mock } from "bun:test";
import { TesotaCredentials } from "../../dist/integrations/tesota-credentials.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

const directory = process.env["TESOTA_TEST_AUTH_DIRECTORY"];
if (!directory) throw new Error("Synthetic storage required");
const createProvider = openaiProvider;

// Diagnose only synthetic storage, without emitting the credential, the command, or raw exception text.
async function storageOperation(action, operation) {
  try { return await operation(); }
  catch (error) {
    const code = typeof error?.code === "string" ? error.code : error?.name ?? "unknown";
    console.error(`Synthetic credential ${action} failed (${code}).`);
    throw error;
  }
}

mock.module("../../dist/integrations/tesota-credentials.js", () => ({
  TesotaCredentials: class extends TesotaCredentials {
    constructor() { super(directory); }
    read(...args) { return storageOperation("read", () => super.read(...args)); }
    modify(...args) { return storageOperation("modify", () => super.modify(...args)); }
    delete(...args) { return storageOperation("delete", () => super.delete(...args)); }
  },
}));
mock.module("@earendil-works/pi-ai/providers/openai", () => ({
  openaiProvider: () => {
    const provider = createProvider();
    provider.auth.oauth.login = async () => {
      return { type: "oauth", access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3_600_000 };
    };
    return provider;
  },
}));
for (const stream of [process.stdin, process.stdout, process.stderr]) Object.defineProperty(stream, "isTTY", { value: true });
globalThis.fetch = async () => { throw new Error("NETWORK_FORBIDDEN"); };
