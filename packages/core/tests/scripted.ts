import { type Context, fauxAssistantMessage, type FauxResponseStep, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "../../../src/contract.ts";
import type { ScriptStep } from "./engine.ts";

/** A verifier that settles every run without checking anything, for tests about the rest of the session. */
export const accepts: ExtensionFactory = (pi) => { pi.on("agent_before_settle", () => undefined); };

/** A scripted step as the reply Pi's scripted model gives. */
export function scriptedReply(step: ScriptStep): FauxResponseStep {
  if (typeof step === "string") return fauxAssistantMessage(step);
  // The scripted model is typed with the transcript alone; what it is given is the whole request, prompt and tools included.
  if ("seen" in step) return (context, options) => { step.seen(context as unknown as Context, options); return fauxAssistantMessage(step.reply); };
  if ("error" in step) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
  if ("calls" in step) {
    return fauxAssistantMessage(step.calls.map((call) => fauxToolCall(call.tool, call.args)),
      { stopReason: step.cutOff === true ? "length" : "toolUse" });
  }
  return fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
}
