import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  type AgentBeforeSettleEvent, type AgentBeforeSettleEventResult, createAgentSession, DefaultResourceLoader,
  type ExtensionAPI as PiExtensionAPI, type ExtensionContext as PiExtensionContext, type InputEvent as PiInputEvent,
  type InputEventResult, ModelRuntime, SessionManager, type SessionStartEvent as PiSessionStartEvent, SettingsManager,
  type ToolExecutionStartEvent as PiToolExecutionStartEvent, type ToolResultEvent as PiToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI, ExtensionContext, InputEvent, InputResult, Session, SessionOutcome, SessionStartEvent, SettleEvent, SettleResult,
  ToolExecutionStartEvent, ToolResultEvent,
} from "../../src/contract.ts";
import type { ScriptStep, SessionOptions, TestEngine } from "../engine.ts";

/** Compiles only when `Actual` satisfies `Required`. */
type Satisfies<Actual extends Required, Required> = Actual;

/**
 * Pi must satisfy the contract: these fail to compile when a pinned Pi
 * release drops or changes something Tesota uses. TypeScript does not
 * compare overloads with overloads, so `on` is checked event by event:
 * what Pi passes a handler must satisfy the contract's event, and what a
 * contract handler returns must be a result Pi accepts.
 */
export type PiSatisfiesContract = [
  Satisfies<Pick<PiExtensionAPI, Exclude<keyof ExtensionAPI, "on">>, Omit<ExtensionAPI, "on">>,
  Satisfies<PiExtensionContext, ExtensionContext>,
  Satisfies<PiSessionStartEvent, SessionStartEvent>,
  Satisfies<PiInputEvent, InputEvent>,
  Satisfies<InputResult, InputEventResult>,
  Satisfies<PiToolExecutionStartEvent, ToolExecutionStartEvent>,
  Satisfies<PiToolResultEvent, ToolResultEvent>,
  Satisfies<AgentBeforeSettleEvent, SettleEvent>,
  Satisfies<SettleResult, AgentBeforeSettleEventResult>,
];

/** Pi's API as the contract; `PiSatisfiesContract` is what makes this sound. */
const asContract = (pi: PiExtensionAPI): ExtensionAPI => pi as unknown as ExtensionAPI;

const reply = (step: ScriptStep) =>
  typeof step === "string" ? fauxAssistantMessage(step) : fauxAssistantMessage([fauxToolCall(step.tool, step.args)]);

let sessions = 0;

/** Pi 1.3.0 through its SDK, on Pi's scripted model, with no state outside a temporary folder. */
export const piEngine: TestEngine = {
  name: "Pi 1.3.0",
  lacks: new Set(["settle-results-accumulate", "settle-failure-is-incomplete", "settle-can-be-cancelled"]),
  async createSession(options: SessionOptions): Promise<Session> {
    const agentDir = mkdtempSync(join(tmpdir(), "tesota-core-pi-"));
    const faux = registerFauxProvider({ provider: `scripted-${++sessions}`, ...options.slow ? { tokensPerSecond: 20 } : {} });
    faux.setResponses(options.script.map(reply));
    const model = faux.getModel();
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
    modelRuntime.registerProvider(model.provider, {
      baseUrl: model.baseUrl, api: model.api,
      models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input,
        cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens, baseUrl: model.baseUrl }],
    });
    await modelRuntime.setRuntimeApiKey(model.provider, "scripted");

    let outcome: SessionOutcome | undefined;
    /** Whether the last run settled aborted, from Pi's `agent_settled`. */
    let settled: boolean | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        ...options.extensions.map((factory) => (pi: PiExtensionAPI) => factory(asContract(pi))),
        (pi: PiExtensionAPI) => { pi.on("agent_settled", (event) => { settled = event.aborted; }); },
      ],
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: options.cwd, agentDir, model, modelRuntime, resourceLoader,
      sessionManager: SessionManager.inMemory(options.cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    });
    await session.bindExtensions({});

    const lastAssistant = () => session.messages.findLast((message) => message.role === "assistant");
    return {
      async prompt(text) {
        settled = undefined;
        await session.prompt(text);
        const last = lastAssistant();
        outcome = settled === true || (last?.role === "assistant" && last.stopReason === "aborted") ? "aborted"
          : last?.role === "assistant" && last.stopReason === "error" ? "error" : "completed";
      },
      abort: () => session.abort(),
      messages: () => session.messages.filter((message) => message.role !== "system").map((message) =>
        "customType" in message && typeof message.customType === "string"
          ? { role: message.role, customType: message.customType } : { role: message.role }),
      lastAssistantText: () => session.getLastAssistantText(),
      stats: () => {
        const { tokens } = session.getSessionStats();
        return { tokens: { input: tokens.input, output: tokens.output, total: tokens.total } };
      },
      outcome: () => outcome,
      dispose: () => { session.dispose(); faux.unregister(); },
    };
  },
};
