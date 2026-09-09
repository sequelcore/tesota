import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import {
  LIVE_CODEX_MODEL_ID,
  runLiveCodexExperiment,
} from "./integrations/pi.js";

function printAuthEvent(event: AuthEvent): void {
  switch (event.type) {
    case "auth_url":
      console.log(`Open this OAuth URL in a browser:\n${event.url}`);
      break;
    case "info":
      console.log(`OAuth info: ${event.message}`);
      break;
    case "progress":
      console.log(`OAuth progress: ${event.message}`);
      break;
    case "device_code":
      console.log("The unexpected device-code flow was not selected.");
      break;
  }
}

async function main(): Promise<void> {
  const readline = createInterface({ input, output });
  const authInteraction: AuthInteraction = {
    prompt: async (prompt: AuthPrompt): Promise<string> => {
      if (prompt.type === "select") return "browser";
      return readline.question(`${prompt.message}\n> `);
    },
    notify: printAuthEvent,
  };

  try {
    const result = await runLiveCodexExperiment({
      authInteraction,
      modelId: LIVE_CODEX_MODEL_ID,
      includeAbortProbe: true,
    });
    const probes = [result.turn, ...(result.abortProbe === undefined ? [] : [result.abortProbe])];
    console.log(JSON.stringify({
      provider: result.turn.provider,
      api: result.turn.api,
      model: result.turn.model,
      authType: result.turn.authType,
      modelRequests: probes.reduce((count, probe) => count + probe.providerRequestCount, 0),
      turn: result.turn,
      abortProbe: result.abortProbe,
    }, null, 2));
    if (result.turn.status !== "completed" || !result.turn.responseMatchesExpectedToken ||
        result.turn.toolCallCount !== 0 || result.turn.toolExecutionCount !== 0) {
      process.exitCode = 1;
    }
  } catch {
    console.log(JSON.stringify({
      provider: "openai-codex",
      model: LIVE_CODEX_MODEL_ID,
      disposition: "live_experiment_failed_without_secret_details",
    }));
    process.exitCode = 1;
  } finally {
    readline.close();
  }
}

await main();
