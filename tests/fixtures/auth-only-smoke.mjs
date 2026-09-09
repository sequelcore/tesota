// Synthetic terminal only: capture the private presentation without printing it.
import { mock } from "bun:test";
import * as pi from "@earendil-works/pi-ai";

if (process.env["TESOTA_TEST_CAPTURED"] !== "1") {
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    Object.defineProperty(stream, "isTTY", { value: true });
  }
}
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (text, ...args) => {
  if (String(text).startsWith("Open https://auth.openai.com/codex/device manually.")) return true;
  return write(text, ...args);
};
const create = pi.createModels;
mock.module("@earendil-works/pi-ai", () => ({
  ...pi,
  createModels: () => {
    const models = create();
    models.login = async (_provider, _type, interaction) => {
      if (process.env["TESOTA_TEST_CAPTURED"] === "1") throw new Error("LOGIN_MUST_NOT_START");
      const method = await interaction.prompt({ type: "select", message: "offline",
        options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }] });
      if (method !== "device_code") throw new Error("Incorrect selection");
      interaction.notify({ type: "device_code", verificationUri: "https://auth.openai.com/codex/device",
        userCode: "TEST-ONLY", intervalSeconds: 5, expiresInSeconds: 900 });
      return undefined;
    };
    return models;
  },
}));
// No real network is reachable in this compiled smoke.
globalThis.fetch = () => { throw new Error("Offline smoke forbids network"); };
