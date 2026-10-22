import { type Context, type CredentialStore, fauxAssistantMessage, type FauxResponseStep, fauxToolCall, type MutableModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { spyOn } from "bun:test";
import type { ExtensionFactory } from "../../../src/contract.ts";
import type { ScriptStep } from "./engine.ts";

/**
 * Signs `models` in to OpenAI with ChatGPT, whose `GET /models` on the token
 * lists `served` (#563, #566). Calling the result stops answering that list.
 */
export async function signInWithChatGPT(models: MutableModels, credentials: CredentialStore, served: readonly string[]): Promise<() => void> {
  await credentials.modify("openai", async () => ({ type: "oauth", access: "token", refresh: "refresh", expires: Date.now() + 3_600_000 }));
  models.setProvider(openaiProvider());
  const listed = spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => String(url) === "https://api.openai.com/v1/models"
    ? Response.json({ models: served.map((slug) => ({ slug })) }) : Response.error()) as never);
  return () => { listed.mockRestore(); };
}

/** A verifier that settles every run without checking anything, for tests about the rest of the session. */
export const accepts: ExtensionFactory = (pi) => { pi.on("agent_before_settle", () => undefined); };

/** A scripted step as the reply Pi's scripted model gives. */
export function scriptedReply(step: ScriptStep): FauxResponseStep {
  if (typeof step === "string") return fauxAssistantMessage(step);
  // The scripted model is typed with the transcript alone; what it is given is the whole request, prompt and tools included.
  if ("seen" in step) return (context, options) => { step.seen(context as unknown as Context, options); return fauxAssistantMessage(step.reply); };
  if ("error" in step) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
  if ("calls" in step) {
    return fauxAssistantMessage(step.calls.map((call) => fauxToolCall(call.tool, call.args, call.id === undefined ? {} : { id: call.id })),
      { stopReason: step.cutOff === true ? "length" : "toolUse" });
  }
  return fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
}
