import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FilledEditor } from "./editor.js";
import { EvidenceFooter } from "./footer.js";
import { registerGate } from "./gate.js";
import { registerMessages } from "./messages.js";
import { suggestChecks } from "./projects.js";
import { hasContracts, proveTool } from "./prove-tool.js";
import { readiness } from "./verification/footer-rule.js";
import { mountWelcomeHeader, TUMBLEWEED_FRAME_MS, tumbleweedFrames, WelcomeHeader } from "./welcome-header.js";

/**
 * Tesota's Pi extension: it puts the palo fierro in Pi's header
 * (`WelcomeHeader`) and its tumbleweed in Pi's working indicator
 * (`tumbleweedFrames`), draws the input as a filled block (`FilledEditor`) over
 * a footer that shows the gate's evidence (`EvidenceFooter`), offers `prove`
 * where there are contracts, holds a run open while a changed file's
 * contracts do not prove (`registerGate`), and styles the gate's messages
 * and receipt (`registerMessages`).
 */
export default function tesota(pi: ExtensionAPI): void {
  pi.registerTool(proveTool);
  const progress = registerGate(pi);
  registerMessages(pi);
  pi.on("session_start", (_event, ctx) => {
    const contracts = hasContracts(ctx.cwd);
    progress.ready(readiness(contracts, suggestChecks(ctx.cwd).length > 0));
    // In the terminal the footer shows the session runs with Tesota; other clients have only this status.
    if (ctx.mode !== "tui") ctx.ui.setStatus("tesota", "Tesota");
    // Unless quietStartup hides it, Pi lists what it loaded beneath the header, so the tree leaves it room.
    const listed = (pi.getSettings().quietStartup ?? false) === false;
    ctx.ui.setHeader((tui, theme) => mountWelcomeHeader(new WelcomeHeader(ctx.cwd, theme,
      { requestRender: () => tui.requestRender(), terminalRows: () => tui.terminal.rows,
        stageShare: listed ? 1 / 3 : 1 / 2 }), tui));
    // While the agent works, the scene's tumbleweed rolls where Pi shows its working indicator.
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator({ frames: tumbleweedFrames(ctx.ui.theme), intervalMs: TUMBLEWEED_FRAME_MS });
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new FilledEditor(tui, theme, keybindings, () => ctx.ui.theme));
    ctx.ui.setFooter((tui, theme, data) => new EvidenceFooter(theme, data, progress, { cwd: ctx.cwd,
      model: () => ctx.model === undefined ? "no model"
        : ctx.model.reasoning ? `${ctx.model.id} ${pi.getThinkingLevel()}` : ctx.model.id,
      context: () => ctx.getContextUsage() }, () => tui.requestRender()));
    if (contracts) pi.setActiveTools([...new Set([...pi.getActiveTools(), proveTool.name])]);
  });
}
