import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ScriptStep } from "./engine.ts";

/** A scripted step as the reply Pi's scripted model gives. */
export function scriptedReply(step: ScriptStep): AssistantMessage {
  if (typeof step === "string") return fauxAssistantMessage(step);
  if ("error" in step) return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
  if ("calls" in step) {
    return fauxAssistantMessage(step.calls.map((call) => fauxToolCall(call.tool, call.args)),
      { stopReason: step.cutOff === true ? "length" : "toolUse" });
  }
  return fauxAssistantMessage([fauxToolCall(step.tool, step.args)], { stopReason: "toolUse" });
}
