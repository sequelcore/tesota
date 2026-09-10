import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall,
  type Context, type FauxResponseStep } from "@earendil-works/pi-ai";
import { PI_VERIFICATION_LIMITS, runPiSession, type PiSessionResult } from "../src/integrations/pi.js";
import { configuredOxlint, runOxlint } from "../src/verification/oxlint.js";
import { VERIFICATION_FIXTURE, verificationProbePasses, verificationSourceIdentity,
  serializeVerificationProbe } from "../src/integrations/pi-verification-evidence.js";

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5_000,
}).trim();
const check = configuredOxlint(process.cwd(), bun);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function provider(steps: FauxResponseStep[]) {
  const faux = fauxProvider({ models: [{ id: "offline", name: "Offline" }], tokensPerSecond: 100_000 });
  faux.setResponses(steps);
  const contexts: Context[] = [];
  const stream = vi.fn<typeof faux.provider.streamSimple>((model, context, options) => {
    contexts.push({ ...context, messages: structuredClone(context.messages) });
    expect(options).toMatchObject({ maxRetries: 0, transport: "sse", cacheRetention: "none" });
    expect(context.tools?.map((tool) => tool.name)).toEqual(["tesota_verify"]);
    expect(context.tools?.[0]?.parameters).toMatchObject({ properties: { input: { const: VERIFICATION_FIXTURE } } });
    return faux.provider.streamSimple(model, context, options);
  });
  return { model: faux.getModel(), stream, contexts };
}

it("executes the real fixed verifier and supplies only its bounded result to a live-path continuation", async () => {
  const fake = provider([
    fauxAssistantMessage(fauxToolCall("tesota_verify", { input: VERIFICATION_FIXTURE })),
    fauxAssistantMessage("TESOTA_VERIFICATION_OK"),
  ]);
  const result = await runPiSession({ scenario: "live_verification", check, input: VERIFICATION_FIXTURE, ...fake });
  expect(result).toMatchObject({ status: "completed", modelInvocationCount: 2, verificationInvocationCount: 1 });
  expect(verificationProbePasses(result)).toBe(true);
  expect(result.issuedEvidence).toBe(result.verification);
  expect(result.verification).toMatchObject({ status: "check_failed", process: "exited",
    diagnostics: [{ rule: "eslint(no-debugger)" }] });
  const returned = fake.contexts[1]?.messages.filter((message) => message.role === "toolResult");
  expect(returned).toHaveLength(1);
  expect(returned?.[0]?.content).toEqual([{ type: "text", text: "Tesota verification check_failed; diagnostics=1" }]);
  expect(JSON.stringify(returned)).not.toContain("binding");
  const identity = verificationSourceIdentity();
  const extra = { ...result, response: "SYNTHETIC_PRIVATE", credentials: "SYNTHETIC_PRIVATE",
    events: [...result.events, { type: "verification_denied" as const, input: "SYNTHETIC_PRIVATE", reason: "SYNTHETIC_PRIVATE" }] };
  expect(serializeVerificationProbe(extra, identity, "2026-09-10T00:00:00Z", true)).not.toContain("SYNTHETIC_PRIVATE");
  expect(() => serializeVerificationProbe(result, { ...identity }, "", true)).toThrow("Unrecognized");
  expect(JSON.parse(serializeVerificationProbe(result, identity, "", false)).disposition).toBe("failed");
  const mutations: Partial<PiSessionResult>[] = [
    { status: "unsettled" }, { terminalStopReason: "aborted" }, { budgetExceeded: true },
    { deadlineExpired: true }, { abortRequested: true }, { modelInvocationCount: 1 },
    { verificationInvocationCount: 0 }, { toolExecutionStartCount: 2 },
    { resultSuppliedToContinuation: false }, { response: "" },
  ];
  for (const mutation of mutations) expect(verificationProbePasses({ ...result, ...mutation })).toBe(false);
});

it.each([
  { input: "../outside.ts" },
  { input: VERIFICATION_FIXTURE, command: "SYNTHETIC_PRIVATE" },
  { input: 4 },
])("denies inadmissible model arguments without executing: %j", async (args) => {
  const fake = provider([fauxAssistantMessage(fauxToolCall("tesota_verify", args)), fauxAssistantMessage("TESOTA_VERIFICATION_OK")]);
  const execute = vi.fn(runOxlint);
  const result = await runPiSession({ scenario: "live_verification", check, input: VERIFICATION_FIXTURE,
    verificationExecutor: execute, ...fake });
  expect(execute).not.toHaveBeenCalled();
  expect(verificationProbePasses(result)).toBe(false);
});

it("denies repeated verification and the third model invocation", async () => {
  const call = () => fauxAssistantMessage(fauxToolCall("tesota_verify", { input: VERIFICATION_FIXTURE }));
  const fake = provider([call(), call(), fauxAssistantMessage("TESOTA_VERIFICATION_OK")]);
  const execute = vi.fn(runOxlint);
  const result = await runPiSession({ scenario: "live_verification", check, input: VERIFICATION_FIXTURE,
    verificationExecutor: execute, ...fake });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(fake.stream).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ budgetExceeded: true, verificationInvocationCount: 1, status: "failed" });
  expect(verificationProbePasses(result)).toBe(false);
});

it("rejects unknown tools even if a valid verification follows in the same response", async () => {
  const message = fauxAssistantMessage(fauxToolCall("unknown", { input: VERIFICATION_FIXTURE }));
  message.content.push(fauxToolCall("tesota_verify", { input: VERIFICATION_FIXTURE }));
  const fake = provider([message, fauxAssistantMessage("TESOTA_VERIFICATION_OK")]);
  const result = await runPiSession({ scenario: "live_verification", check, input: VERIFICATION_FIXTURE, ...fake });
  expect(result.toolExecutionStartCount).toBe(2);
  expect(verificationProbePasses(result)).toBe(false);
});

it("bounds a stream that never settles and ignores late completion", async () => {
  vi.useFakeTimers();
  const model = fauxProvider({ models: [{ id: "offline", name: "Offline" }] }).getModel();
  const stream = createAssistantMessageEventStream();
  const running = runPiSession({ scenario: "live_verification", check, input: VERIFICATION_FIXTURE, model, stream: () => stream });
  await vi.advanceTimersByTimeAsync(PI_VERIFICATION_LIMITS.sessionMs + PI_VERIFICATION_LIMITS.settlementMs);
  const result = await running;
  expect(result).toMatchObject({ status: "unsettled", deadlineExpired: true, abortRequested: true });
  const events = [...result.events];
  const message = fauxAssistantMessage("TESOTA_VERIFICATION_OK");
  stream.push({ type: "done", reason: "stop", message });
  stream.end(message);
  await vi.advanceTimersByTimeAsync(0);
  expect(result.events).toEqual(events);
  expect(verificationProbePasses(result)).toBe(false);
});

it("keeps compiled help offline and rejects extra arguments before login", () => {
  for (const args of [["--help"], ["--stored", "unexpected"]]) {
    const result = spawnSync(bun, ["--no-env-file", "dist/live-verification.js", ...args], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    });
    expect(result.status).toBe(args.length === 1 ? 0 : 2);
    expect(result.stdout + result.stderr).not.toContain("Evidence:");
  }
});

it("enforces admission at execution even when the pre-call hook is bypassed, and closes late tools", async () => {
  const tools: AgentTool[] = [];
  vi.spyOn(Agent.prototype, "prompt").mockImplementation(async function (this: Agent) {
    const tool = this.state.tools[0];
    if (tool === undefined) throw new Error("Missing tool");
    tools.push(tool);
    await expect(tool.execute("outside", { input: "../outside.ts" })).rejects.toThrow("denied");
    await expect(tool.execute("extra", { input: VERIFICATION_FIXTURE, command: "ignored" })).rejects.toThrow("denied");
  });
  const fake = provider([]);
  const execute = vi.fn(runOxlint);
  await runPiSession({ scenario: "live_verification", check, input: VERIFICATION_FIXTURE,
    verificationExecutor: execute, ...fake });
  const tool = tools[0];
  if (tool === undefined) throw new Error("Missing tool");
  await expect(tool.execute("late", { input: VERIFICATION_FIXTURE })).rejects.toThrow("denied");
  expect(execute).not.toHaveBeenCalled();
});
