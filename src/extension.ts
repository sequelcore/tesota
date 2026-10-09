import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { hasContracts, proveTool } from "./prove-tool.js";
import { WelcomeHeader } from "./welcome-header.js";

/**
 * Tesota's Pi extension: it marks the session as running with Tesota and
 * puts the palo fierro in Pi's header (`WelcomeHeader`), offers `prove`
 * where there are contracts, and holds a run open while a changed file's
 * contracts do not prove (`registerGate`).
 */
export default function tesota(pi: ExtensionAPI): void {
  pi.registerTool(proveTool);
  registerGate(pi);
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("tesota", "Tesota");
    ctx.ui.setHeader((tui, theme) => new WelcomeHeader(ctx.cwd, theme,
      { requestRender: () => tui.requestRender(), terminalRows: () => tui.terminal.rows }));
    if (hasContracts(ctx.cwd)) pi.setActiveTools([...new Set([...pi.getActiveTools(), proveTool.name])]);
  });
}
