import { resolve } from "node:path";
import type { ExtensionAPI } from "./contract.js";
import { BarEditor } from "./editor.js";
import { EvidenceFooter } from "./footer.js";
import { type RecordedRequest, registerGate } from "./gate.js";
import { registerMessages } from "./messages.js";
import { hasTlc, modelTool } from "./model-tool.js";
import { suggestChecks } from "./projects.js";
import { annotated, hasContracts, proveTool } from "./prove-tool.js";
import { readiness } from "./verification/footer-rule.js";
import { receiptStanding } from "./receipt.js";
import { mountWelcomeHeader, ORB_FRAME_MS, orbFrames, WelcomeHeader } from "./welcome-header.js";

/**
 * Tesota, as Pi and the engine's shell load it (#446): it mounts the compact header and empty-stage palo fierro
 * (`WelcomeHeader`) and a turning orb in Pi's working indicator
 * (`orbFrames`), draws the input as a full-width prompt band (`BarEditor`) over
 * a footer that shows the gate's evidence (`EvidenceFooter`), offers `prove`
 * where there are contracts or once the agent writes one, and `check_model`
 * where TLC is installed, holds a run open
 * while a changed file's contracts do not prove (`registerGate`), and styles
 * the gate's messages and receipt (`registerMessages`).
 */
export default function tesota(pi: ExtensionAPI, recorded?: () => RecordedRequest | undefined): void {
  pi.registerTool(proveTool);
  pi.registerTool(modelTool);
  const progress = registerGate(pi, recorded);
  registerMessages(pi);
  pi.on("session_start", (_event, ctx) => {
    const contracts = hasContracts(ctx.cwd);
    progress.ready(readiness(contracts, suggestChecks(ctx.cwd).length > 0));
    // A resumed session that settled with a receipt, and had no request since, shows that receipt again.
    progress.resume(ctx.sessionManager.getBranch());
    // In the terminal the footer shows the session runs with Tesota; other clients have only this status.
    if (ctx.mode !== "tui") ctx.ui.setStatus("tesota", "Tesota");
    // Unless quietStartup hides it, Pi lists what it loaded beneath the header, so the tree leaves it room.
    const listed = (pi.getSettings().quietStartup ?? false) === false;
    ctx.ui.setHeader((tui, theme) => mountWelcomeHeader(new WelcomeHeader(ctx.cwd, theme,
      { requestRender: () => tui.requestRender(), terminalRows: () => tui.terminal.rows,
        stageShare: listed ? 1 / 3 : 1 / 2, model: () => ctx.model?.id ?? "no model",
        standing: () => progress.status.step === "settled" ? receiptStanding(progress.status.receipt) : "none",
        working: () => progress.status.step !== "ready" && progress.status.step !== "settled" }), tui));
    // One turning orb for all work phases; the loader changes only its label.
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator({ frames: orbFrames(ctx.ui.theme), intervalMs: ORB_FRAME_MS });
    ctx.ui.setEditorComponent((tui, theme) => new BarEditor(tui, theme, () => ctx.ui.theme));
    ctx.ui.setFooter((tui, theme, data) => new EvidenceFooter(theme, data, progress, { cwd: ctx.cwd,
      model: () => ctx.model === undefined ? "no model"
        : ctx.model.reasoning ? `${ctx.model.id} ${pi.getThinkingLevel()}` : ctx.model.id,
      context: () => ctx.getContextUsage() }, () => tui.requestRender()));
    // The label beside the orb names the gate's running work; the shell listens only while it shows the label (#590).
    ctx.ui.setWorkingDetail(progress.operations);
    if (contracts) offer(proveTool.name);
    if (hasTlc()) offer(modelTool.name);
  });
  // A contract the agent writes where there was none turns on `prove` for the rest of the session, so it can prove it while it works.
  pi.on("tool_result", (event, ctx) => {
    const path = event.input["path"];
    if ((event.toolName === "write" || event.toolName === "edit") && !event.isError && typeof path === "string" &&
      annotated(resolve(ctx.cwd, path))) offer(proveTool.name);
  });
  function offer(name: string): void {
    if (!pi.getActiveTools().includes(name)) pi.setActiveTools([...pi.getActiveTools(), name]);
  }
}
