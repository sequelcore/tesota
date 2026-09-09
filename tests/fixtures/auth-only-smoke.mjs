// Synthetic terminal only: capture the private presentation without printing it.
import { mock } from "bun:test";
import * as pi from "@earendil-works/pi-ai";

const scenario = process.env["TESOTA_TEST_SCENARIO"];
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay > 180_000) {
    const expected = process.argv.includes("--full-probe") ? 249_000 : 185_000;
    if (delay !== expected) throw new Error("Incorrect process watchdog");
  }
  return originalTimeout(callback, scenario === "login_timeout" && delay === 180_000 ? 10 : delay, ...args);
};
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
    let authenticated = false;
    let calls = 0;
    models.login = async (_provider, _type, interaction) => {
      if (scenario === "forbid_login") {
        process.stderr.write("LOGIN_MUST_NOT_START\n");
        process.exit(99);
      }
      if (process.env["TESOTA_TEST_CAPTURED"] === "1") throw new Error("LOGIN_MUST_NOT_START");
      const method = await interaction.prompt({ type: "select", message: "offline",
        options: [{ id: "browser", label: "Browser" }, { id: "device_code", label: "Device" }] });
      if (method !== "device_code") throw new Error("Incorrect selection");
      interaction.notify({ type: "device_code", verificationUri: "https://auth.openai.com/codex/device",
        userCode: "TEST-ONLY", intervalSeconds: 5, expiresInSeconds: 900 });
      if (scenario === "login_failure") throw new Error("SYNTHETIC_PRIVATE");
      if (scenario === "login_timeout") return new Promise(() => {});
      authenticated = true;
      return undefined;
    };
    models.streamSimple = (_model, context, options) => {
      if (!authenticated || context.tools.length !== 0 || ++calls > 2) throw new Error("Invalid probe dispatch");
      const events = pi.createAssistantMessageEventStream();
      const tool = scenario === (calls === 1 ? "normal_tool" : "abort_tool");
      const message = pi.fauxAssistantMessage(tool ? pi.fauxToolCall("unavailable", {}) :
        scenario === "normal_failure" ? "SYNTHETIC_PRIVATE" : "TESOTA_M31A_OK");
      if (calls === 1 || tool || scenario === "abort_failure") {
        events.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
        events.end(message);
      } else {
        options.signal.addEventListener("abort", () => {
          const aborted = { ...message, stopReason: "aborted" };
          events.push({ type: "error", reason: "aborted", error: aborted });
          events.end(aborted);
        }, { once: true });
        events.push({ type: "start", partial: message });
        events.push({ type: "text_delta", contentIndex: 0, delta: "SYNTHETIC_PRIVATE", partial: message });
      }
      return events;
    };
    return models;
  },
}));
// No real network is reachable in this compiled smoke.
globalThis.fetch = () => { throw new Error("Offline smoke forbids network"); };
