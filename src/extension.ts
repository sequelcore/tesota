import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hasContracts, proveTool } from "./prove-tool.js";

/** Tesota's Pi extension: it marks the session as running with Tesota and offers `prove` where there are contracts. */
export default function tesota(pi: ExtensionAPI): void {
  pi.registerTool(proveTool);
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("tesota", "Tesota");
    if (hasContracts(ctx.cwd)) pi.setActiveTools([...new Set([...pi.getActiveTools(), proveTool.name])]);
  });
}
