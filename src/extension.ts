import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { hasContracts, proveTool } from "./prove-tool.js";

/**
 * Tesota's Pi extension: it marks the session as running with Tesota, offers
 * `prove` where there are contracts, and holds a run open while a changed
 * file's contracts do not prove (`registerGate`).
 */
export default function tesota(pi: ExtensionAPI): void {
  pi.registerTool(proveTool);
  registerGate(pi);
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("tesota", "Tesota");
    if (hasContracts(ctx.cwd)) pi.setActiveTools([...new Set([...pi.getActiveTools(), proveTool.name])]);
  });
}
