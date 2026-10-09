import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGate } from "./gate.js";
import { hasContracts, proveTool } from "./prove-tool.js";
import { mountWelcomeHeader, WelcomeHeader } from "./welcome-header.js";

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
    // In the terminal the status takes the theme's success color, sage in Tesota's own themes; other clients get text.
    ctx.ui.setStatus("tesota", ctx.mode === "tui" ? ctx.ui.theme.fg("success", "Tesota") : "Tesota");
    // Unless quietStartup hides it, Pi lists what it loaded beneath the header, so the tree leaves it room.
    const listed = (pi.getSettings().quietStartup ?? false) === false;
    ctx.ui.setHeader((tui, theme) => mountWelcomeHeader(new WelcomeHeader(ctx.cwd, theme,
      { requestRender: () => tui.requestRender(), terminalRows: () => tui.terminal.rows,
        stageShare: listed ? 1 / 3 : 1 / 2 }), tui));
    if (hasContracts(ctx.cwd)) pi.setActiveTools([...new Set([...pi.getActiveTools(), proveTool.name])]);
  });
}
