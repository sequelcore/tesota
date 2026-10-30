import { resolve } from "node:path";
import type { ExtensionAPI } from "./contract.js";
import { BarEditor } from "./editor.js";
import { EvidenceFooter } from "./footer.js";
import { type RecordedRequest, registerGate } from "./gate.js";
import { registerMessages } from "./messages.js";
import { findModels } from "./model-check.js";
import { hasTlc, MODEL_GUIDELINES, modelTool } from "./model-tool.js";
import { onPath, suggestChecks } from "./projects.js";
import { annotated, hasContracts, PROVE_GUIDELINES, proveTool } from "./prove-tool.js";
import { readiness } from "./verification/footer-rule.js";
import { mountWelcomeHeader, WelcomeHeader } from "./welcome-header.js";
import { workingOrb } from "./working-orb.js";

/**
 * Tesota, as Pi and the engine's shell load it (#446): it mounts the welcome screen
 * (`WelcomeHeader`) and the working orb, its motion by phase (`workingOrb`),
 * draws the input as a full-width prompt band (`BarEditor`) over
 * a footer that shows the gate's evidence (`EvidenceFooter`), holds a run open
 * while a changed file's contracts do not prove (`registerGate`), and styles
 * the gate's messages and receipt (`registerMessages`).
 *
 * The agent knows from the start what it can verify (#779): `prove` where
 * Dafny is on the PATH or the project has contracts, and `check_model` where
 * TLC is installed. Each tool's rules join the prompt where the project
 * already has what they are about, or once the agent writes its first
 * contract or model.
 */
export default function tesota(pi: ExtensionAPI, recorded?: () => RecordedRequest | undefined): void {
  const rules = { prove: false, model: false };
  pi.registerTool({ ...proveTool, promptGuidelines: () => rules.prove ? PROVE_GUIDELINES : [] });
  pi.registerTool({ ...modelTool, promptGuidelines: () => rules.model ? MODEL_GUIDELINES : [] });
  const progress = registerGate(pi, recorded);
  registerMessages(pi);
  pi.on("session_start", async (_event, ctx) => {
    const contracts = hasContracts(ctx.cwd);
    progress.ready(readiness(contracts, suggestChecks(ctx.cwd).length > 0));
    // A resumed session that settled with a receipt, and had no request since, shows that receipt again.
    progress.resume(ctx.sessionManager.getBranch());
    // In the terminal the footer shows the session runs with Tesota; other clients have only this status.
    if (ctx.mode !== "tui") ctx.ui.setStatus("tesota", "Tesota");
    ctx.ui.setHeader((_tui, theme) => mountWelcomeHeader(new WelcomeHeader(ctx.cwd, theme)));
    // The orb moves by phase: working, verifying, compacting, retrying.
    if (ctx.mode === "tui") ctx.ui.setWorkingIndicator(workingOrb);
    ctx.ui.setEditorComponent((tui, theme) => new BarEditor(tui, theme, () => ctx.ui.theme));
    ctx.ui.setFooter((tui, theme, data) => new EvidenceFooter(theme, data, progress, { cwd: ctx.cwd,
      model: () => ctx.model === undefined ? "no model"
        : ctx.model.reasoning ? `${ctx.model.id} ${pi.getThinkingLevel()}` : ctx.model.id,
      context: () => ctx.getContextUsage() }, () => tui.requestRender()));
    // The label beside the orb names the gate's running work; the shell listens only while it shows the label (#590).
    ctx.ui.setWorkingDetail(progress.operations);
    rules.prove = contracts;
    if (contracts || onPath("dafny")) offer(proveTool.name);
    if (hasTlc()) {
      rules.model = (await findModels(ctx.cwd)).length > 0;
      offer(modelTool.name);
    }
  });
  // The first contract or model the agent writes brings its tool's rules, and `prove` where it was not offered yet.
  pi.on("tool_result", (event, ctx) => {
    const path = event.input["path"];
    if ((event.toolName !== "write" && event.toolName !== "edit") || event.isError || typeof path !== "string") return;
    if (path.endsWith(".tla") || path.endsWith(".qnt")) rules.model = true;
    if (!annotated(resolve(ctx.cwd, path))) return;
    rules.prove = true;
    offer(proveTool.name);
  });
  function offer(name: string): void {
    if (!pi.getActiveTools().includes(name)) pi.setActiveTools([...pi.getActiveTools(), name]);
  }
}
