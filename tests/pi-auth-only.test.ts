import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage, type FetchFunction } from "@earendil-works/pi-ai";
import { runLiveCodex, deviceCodeAuth, deviceCodeTerminalRenderer, LIVE_LIMITS,
  LIVE_CODEX_EXPECTED_TOKEN, type LiveCodexRunResult } from "../src/integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence, type LiveSourceIdentity } from "../src/integrations/pi-live-evidence.js";

// Real locked Models instance; only login and provider stream dispatch are synthetic.
const harness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@earendil-works/pi-ai", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, createModels: () => harness.create() };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function fixture() {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  const models = actual.createModels();
  harness.create.mockReturnValue(models);
  const login = vi.spyOn(models, "login").mockResolvedValue({ type: "oauth", access: "SYNTHETIC_PRIVATE",
    refresh: "SYNTHETIC_PRIVATE", expires: 0 });
  let calls = 0;
  const stream = vi.spyOn(models, "streamSimple").mockImplementation((_model, _context, options) => {
    calls += 1;
    const events = createAssistantMessageEventStream();
    const message = fauxAssistantMessage(LIVE_CODEX_EXPECTED_TOKEN);
    if (calls === 1) {
      events.push({ type: "done", reason: "stop", message }); events.end(message);
    } else {
      options?.signal?.addEventListener("abort", () => {
        const aborted = { ...message, stopReason: "aborted" as const };
        events.push({ type: "error", reason: "aborted", error: aborted }); events.end(aborted);
      }, { once: true });
      events.push({ type: "start", partial: message });
      events.push({ type: "text_delta", contentIndex: 0, delta: "offline", partial: message });
    }
    return events;
  });
  const cancellation = new AbortController();
  const interaction = deviceCodeAuth(vi.fn(), cancellation.signal);
  return { models, login, stream, interaction, cancellation };
}

function evidence(run: LiveCodexRunResult, identity = liveSourceIdentity()) {
  return JSON.parse(serializeLiveEvidence(identity, "2026-01-01T00:00:00.000Z", run));
}

it("stored authentication runs probes without login prompts and rejects missing credentials", async () => {
  const f = await fixture();
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  const credentials = new actual.InMemoryCredentialStore();
  const prompt = vi.fn(async (): Promise<string> => { throw new Error("Unexpected login"); });
  const interaction = { authenticationMethod: "stored" as const, prompt, notify: vi.fn(), signal: f.cancellation.signal };
  const auth = vi.spyOn(f.models, "getAuth").mockResolvedValue({ auth: { apiKey: "SYNTHETIC_PRIVATE" } });
  expect((await runLiveCodex("full_probe", interaction, credentials)).disposition).toBe("failed");
  expect(auth).not.toHaveBeenCalled();
  expect(f.stream).not.toHaveBeenCalled();
  await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "SYNTHETIC_PRIVATE",
    refresh: "SYNTHETIC_PRIVATE", expires: Date.now() + 3_600_000 }));
  const result = await runLiveCodex("full_probe", interaction, credentials);
  expect(result).toMatchObject({ disposition: "passed", authenticationMethod: "stored" });
  expect(f.login).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(evidence(result))).not.toContain("SYNTHETIC_PRIVATE");
});

// Exercise actual Models auth application, lazy provider and SSE streamSimple.
// Only public OAuth login and per-request fetch are synthetic; no global fetch patch.
async function transportFixture(fetch: FetchFunction) {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  const models = actual.createModels();
  harness.create.mockReturnValue(models);
  const setProvider = models.setProvider.bind(models);
  vi.spyOn(models, "setProvider").mockImplementation((provider) => {
    const oauth = provider.auth.oauth;
    if (oauth === undefined) throw new Error("Missing fixture OAuth boundary");
    // Deliberately invalid as a real credential; sufficient for Pi's local parser.
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "SYNTHETIC_PRIVATE" },
    })).toString("base64url");
    vi.spyOn(oauth, "login").mockResolvedValue({ type: "oauth",
      access: `fixture.${payload}.fixture`, refresh: "SYNTHETIC_PRIVATE", expires: Date.now() + 3_600_000 });
    vi.spyOn(oauth, "refresh").mockRejectedValue(new Error("Unexpected fixture refresh"));
    setProvider(provider);
  });
  const streamSimple = models.streamSimple.bind(models);
  const invoke = vi.spyOn(models, "streamSimple").mockImplementation((model, context, options) =>
    streamSimple(model, context, { ...options, fetch }));
  const run = await runLiveCodex("full_probe", deviceCodeAuth(vi.fn(), new AbortController().signal));
  return { run, invoke };
}

it.each([
  { status: 403, stage: "http_rejection" },
  { status: 429, stage: "http_rejection" },
  { status: 200, stage: "after_response" },
  { status: null, stage: "response_not_observed" },
])("retains only safe response observations for SSE failure $status", async ({ status, stage }) => {
  const fetch = vi.fn<FetchFunction>(async () => {
    if (status === null) throw new Error("SYNTHETIC_PRIVATE Bearer secret before response");
    const body = status === 200 ?
      'data: {"type":"error","code":"SYNTHETIC_PRIVATE","message":"SYNTHETIC_PRIVATE"}\n\n' :
      '{"error":{"code":"SYNTHETIC_PRIVATE","message":"SYNTHETIC_PRIVATE"}}';
    return new Response(body, { status, headers: {
      "content-type": "text/event-stream", "set-cookie": "SYNTHETIC_PRIVATE",
      authorization: "Bearer SYNTHETIC_PRIVATE",
    } });
  });
  const { run, invoke } = await transportFixture(fetch);
  expect(fetch).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledOnce();
  expect(run.authentication.outcome).toBe("succeeded");
  expect(run.experiment?.turn).toMatchObject({ status: "failed", terminalStopReason: "error",
    modelInvocationCount: 1, requestBudgetExceeded: false, deadlineExpired: false,
    providerDiagnostic: { httpStatus: status, failureStage: stage, providerErrorCode: null } });
  expect(run.experiment?.abortProbe).toBeNull();
  const record = evidence(run);
  expect(record.turn.providerDiagnostic).toEqual({ httpStatus: status, failureStage: stage, providerErrorCode: null });
  expect(JSON.stringify(record)).not.toMatch(/SYNTHETIC_PRIVATE|Bearer|set-cookie|errorMessage|stack/);
  expect(run.disposition).toBe("failed");
});

it("preserves normal and aborted outcomes through the real SSE adapter", async () => {
  let calls = 0;
  const fetch = vi.fn<FetchFunction>(async (_input, init) => {
    const abortProbe = ++calls === 2;
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (event: unknown): void => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        emit({ type: "response.output_item.added", output_index: 0,
          item: { type: "message", id: "fixture", role: "assistant", content: [] } });
        emit({ type: "response.output_text.delta", output_index: 0, delta: LIVE_CODEX_EXPECTED_TOKEN });
        if (abortProbe) {
          if (signal == null) throw new Error("Missing fixture cancellation");
          signal.addEventListener("abort", () => controller.error(new Error("SYNTHETIC_PRIVATE abort")), { once: true });
        } else {
          emit({ type: "response.completed", response: { status: "completed", output: [] } });
          controller.close();
        }
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const { run, invoke } = await transportFixture(fetch);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(run.disposition).toBe("passed");
  expect(run.experiment?.turn).toMatchObject({ status: "completed", terminalStopReason: "stop",
    providerDiagnostic: { httpStatus: 200, failureStage: null, providerErrorCode: null } });
  expect(run.experiment?.abortProbe).toMatchObject({ status: "aborted", terminalStopReason: "aborted",
    abortRequested: true, providerDiagnostic: { httpStatus: 200, failureStage: null, providerErrorCode: null } });
  expect(JSON.stringify(evidence(run))).not.toContain("SYNTHETIC_PRIVATE");
});

it("auth success returns without model lookup, Agent, probes, tools or acceptance", async () => {
  const f = await fixture();
  const lookup = vi.spyOn(f.models, "getModel");
  const prompt = vi.spyOn(Agent.prototype, "prompt");
  const result = await runLiveCodex("auth_only", f.interaction);
  expect(result).toEqual({ mode: "auth_only", authenticationMethod: "device_code", authentication: { outcome: "succeeded", oauthFailureCategory: null },
    experiment: null, inferenceAttempted: false, disposition: "succeeded" });
  expect(f.login).toHaveBeenCalledOnce();
  expect(f.stream).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
  const record = evidence(result);
  expect(record).toMatchObject({ version: 9, mode: "auth_only", authenticationOutcome: "succeeded",
    oauthFailureCategory: null, modelInvocationCount: 0, turn: null, abortProbe: null, disposition: "succeeded" });
  expect(record).not.toHaveProperty("taskAcceptance");
  expect(record).not.toHaveProperty("verification");
  expect(JSON.stringify(record)).not.toContain("SYNTHETIC_PRIVATE");
});

it.each(["stream", "streamSimple", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred"] as const)(
  "blocks attempted %s before dispatch and fails even when the caller catches denial", async (method) => {
    const f = await fixture();
    f.login.mockImplementation(async () => {
      // Inject an accidental call at OAuth completion; no real provider is reachable.
      try { Reflect.apply(f.models[method], f.models, []); } catch { /* accidental suppression */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    const result = await runLiveCodex("auth_only", f.interaction);
    expect(f.stream).not.toHaveBeenCalled();
    expect(result).toMatchObject({ inferenceAttempted: true, disposition: "failed", experiment: null });
    expect(evidence(result)).toMatchObject({ disposition: "failed", modelInvocationCount: 0, turn: null, abortProbe: null });
  },
);

it("full-probe still runs both independent probes after login", async () => {
  const f = await fixture();
  const result = await runLiveCodex("full_probe", f.interaction);
  expect(result.disposition).toBe("passed");
  expect(f.stream).toHaveBeenCalledTimes(2);
  expect(evidence(result)).toMatchObject({ mode: "full_probe", modelInvocationCount: 2, disposition: "passed" });
});

it.each(["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const)(
  "blocks direct provider %s access in AUTH-ONLY", async (method) => {
    const f = await fixture();
    f.login.mockImplementation(async () => {
      const provider = f.models.getProvider("openai-codex");
      const invoke = provider?.[method];
      expect(invoke).toBeDefined();
      try { if (invoke !== undefined) Reflect.apply(invoke, provider, []); } catch { /* deliberate attempt */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    const result = await runLiveCodex("auth_only", f.interaction);
    expect(result).toMatchObject({ inferenceAttempted: true, disposition: "failed", experiment: null });
    expect(f.stream).not.toHaveBeenCalled();
  },
);

it("unknown OAuth failure is distinct from success and never retains its payload", async () => {
  const f = await fixture();
  f.login.mockRejectedValue(new Error("SYNTHETIC_PRIVATE"));
  const result = await runLiveCodex("auth_only", f.interaction);
  expect(result.authentication).toEqual({ outcome: "failed", oauthFailureCategory: "unknown" });
  expect(evidence(result)).toMatchObject({ disposition: "failed", modelInvocationCount: 0 });
});

it("source identity accepts only immutable fixed-file captures, rejecting arbitrary and copied data", () => {
  const identity = liveSourceIdentity();
  expect(Object.isFrozen(identity)).toBe(true);
  expect(Object.keys(identity)).toHaveLength(12);
  for (const [file, digest] of Object.entries(identity)) {
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(createHash("sha256").update(readFileSync(file)).digest("hex"));
  }
  const run: LiveCodexRunResult = { mode: "auth_only", authenticationMethod: "device_code", authentication: { outcome: "succeeded", oauthFailureCategory: null },
    experiment: null, inferenceAttempted: false, disposition: "succeeded" };
  expect(evidence(run, identity).implementation.sourceSha256).toEqual(identity);
  const missing = { ...identity } as Record<string, string>;
  delete missing["bun.lock"];
  for (const value of [{}, missing, { ...identity }, { ...identity, extra: "a".repeat(64) },
    ...["API_KEY=SYNTHETIC_PRIVATE", "https://example.invalid/?token=SYNTHETIC_PRIVATE", "Bearer SYNTHETIC_PRIVATE",
      "a".repeat(63), "A".repeat(64), "g".repeat(64)].map((digest) => ({ ...identity, "bun.lock": digest }))]) {
    expect(() => evidence(run, value as LiveSourceIdentity)).toThrow("Unrecognized live source identity");
  }
});

it("compiled auth-only dispatch help is offline and explicit", () => {
  const output = execFileSync("bun", ["--no-env-file", "dist/live-codex.js", "--auth-only", "--device-code", "--help"], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  expect(output).toContain("ZERO model inference calls; no model probes");
  expect(output).toContain("network authentication");
});

it.skipIf(process.platform !== "win32")("compiled AUTH-ONLY exits with sanitized durable success using offline login", () => {
  const directory = mkdtempSync(join(tmpdir(), "tesota-auth-smoke-"));
  try {
    mkdirSync(join(directory, "experiments/codex/evidence"), { recursive: true });
    const output = execFileSync("bun", ["--no-env-file", "--preload", resolve("tests/fixtures/auth-only-smoke.mjs"),
      resolve("dist/live-codex.js"), "--auth-only", "--device-code"], {
      cwd: directory, encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
    });
    expect(output).toContain("ZERO model inference calls");
    const runs = join(directory, "experiments/codex/runs");
    const [runFile] = readdirSync(runs);
    if (runFile === undefined) throw new Error("Expected one retained run");
    const record = JSON.parse(readFileSync(join(runs, runFile), "utf8"));
    expect(record).toMatchObject({ mode: "auth_only", authenticationOutcome: "succeeded",
      modelInvocationCount: 0, turn: null, abortProbe: null, disposition: "succeeded" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

const deviceNotification = {
  type: "device_code", verificationUri: "https://auth.openai.com/codex/device",
  userCode: "TEST-ONLY", intervalSeconds: 5, expiresInSeconds: 900,
  deviceAuthId: "SYNTHETIC_PRIVATE", access: "SYNTHETIC_PRIVATE",
} as const;
const selection = { type: "select", message: "offline", options: [
  { id: "browser", label: "Browser" }, { id: "device_code", label: "Device" },
] } as const;

it("selects device_code and projects only official URI/user code to the private renderer", async () => {
  const f = await fixture();
  const render = vi.fn();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const auth = deviceCodeAuth(render, f.cancellation.signal);
  f.login.mockImplementation(async (_provider, _type, interaction) => {
    expect(await interaction.prompt(selection)).toBe("device_code");
    interaction.notify(deviceNotification);
    interaction.notify({ type: "info", message: deviceNotification.userCode });
    interaction.notify({ type: "progress", message: deviceNotification.userCode });
    return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
  });
  const result = await runLiveCodex("auth_only", auth);
  expect(f.login).toHaveBeenCalledWith("openai-codex", "oauth", expect.any(Object));
  expect(result.disposition).toBe("succeeded");
  expect(render).toHaveBeenCalledOnce();
  expect(Object.keys(render.mock.calls[0]?.[0]).sort()).toEqual(["userCode", "verificationUri"]);
  expect(render.mock.calls[0]?.[0].userCode === deviceNotification.userCode).toBe(true);
  expect(render.mock.calls[0]?.[0].verificationUri === deviceNotification.verificationUri).toBe(true);
  const contaminated = { ...result, userCode: deviceNotification.userCode, verificationUri: deviceNotification.verificationUri };
  const serialized = serializeLiveEvidence(liveSourceIdentity(), "offline", contaminated);
  for (const value of [deviceNotification.userCode, deviceNotification.verificationUri, "SYNTHETIC_PRIVATE"]) {
    expect(serialized.includes(value)).toBe(false);
  }
  expect(log.mock.calls.length).toBe(0);
  expect(error.mock.calls.length).toBe(0);
});

it.each(["auth_only", "full_probe"] as const)("uses public Pi login selection, polling and exchange before %s with synthetic fetch", async (mode) => {
  const f = await fixture();
  f.login.mockRestore();
  const render = vi.fn();
  const auth = deviceCodeAuth(render, f.cancellation.signal);
  const prompt = vi.spyOn(auth, "prompt");
  const routes: string[] = [];
  const jwt = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline" } })).toString("base64url")}.synthetic`;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const route = String(input);
    routes.push(route);
    if (route === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
      return Response.json({ device_auth_id: "SYNTHETIC_PRIVATE", user_code: deviceNotification.userCode, interval: 5 });
    }
    if (route === "https://auth.openai.com/api/accounts/deviceauth/token") {
      return Response.json({ authorization_code: "SYNTHETIC_PRIVATE", code_verifier: "SYNTHETIC_PRIVATE" });
    }
    if (route === "https://auth.openai.com/oauth/token") {
      return Response.json({ access_token: jwt, refresh_token: "SYNTHETIC_PRIVATE", expires_in: 3600 });
    }
    throw new Error("Unexpected offline route");
  }));
  const result = await runLiveCodex(mode, auth);
  expect(result).toMatchObject({ authenticationMethod: "device_code", disposition: mode === "auth_only" ? "succeeded" : "passed" });
  if (mode === "auth_only") expect(result.experiment).toBeNull();
  expect(prompt).toHaveBeenCalledOnce();
  expect(prompt.mock.calls[0]?.[0]).toMatchObject({ type: "select", options: expect.arrayContaining([
    expect.objectContaining({ id: "device_code" }),
  ]) });
  expect(await prompt.mock.results[0]?.value).toBe("device_code");
  expect(routes).toEqual(["https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token", "https://auth.openai.com/oauth/token"]);
  expect(render).toHaveBeenCalledOnce();
  expect(f.stream).toHaveBeenCalledTimes(mode === "auth_only" ? 0 : 2);
  expect(JSON.stringify(evidence(result)).includes(deviceNotification.userCode)).toBe(false);
});

it.each(["missing_option", "manual_code", "browser_notification", "wrong_uri", "control_code", "repeat"])(
  "rejects unexpected device interaction without fallback, even when caught: %s", async (kind) => {
    const f = await fixture();
    const render = vi.fn();
    const auth = deviceCodeAuth(render, f.cancellation.signal);
    f.login.mockImplementation(async (_provider, _type, interaction) => {
      try {
        if (kind === "missing_option") await interaction.prompt({ type: "select", message: "offline", options: [{ id: "browser", label: "Browser" }] });
        else if (kind === "manual_code") await interaction.prompt({ type: "manual_code", message: "offline" });
        else {
          await interaction.prompt(selection);
          if (kind === "browser_notification") interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize" });
          if (kind === "wrong_uri") interaction.notify({ ...deviceNotification, verificationUri: "https://example.invalid/" });
          if (kind === "control_code") interaction.notify({ ...deviceNotification, userCode: "bad\ncode" });
          if (kind === "repeat") await interaction.prompt(selection);
        }
      } catch { /* denial cannot be turned into success */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    const result = await runLiveCodex("auth_only", auth);
    expect(result).toMatchObject({ disposition: "failed", authentication: { outcome: "failed", oauthFailureCategory: "unknown" } });
    expect(render).not.toHaveBeenCalled();
    expect(f.login).toHaveBeenCalledOnce();
    expect(f.stream).not.toHaveBeenCalled();
  },
);

it("requires every terminal stream before login and rechecks before private presentation", () => {
  const write = vi.fn();
  const terminal = { stdin: { isTTY: true }, stdout: { isTTY: true }, stderr: { isTTY: true, write } };
  for (const stream of [terminal.stdin, terminal.stdout, terminal.stderr]) {
    stream.isTTY = false;
    expect(() => deviceCodeTerminalRenderer(terminal)).toThrow("interactive, unrecorded terminal");
    stream.isTTY = true;
  }
  const render = deviceCodeTerminalRenderer(terminal);
  render(deviceNotification);
  expect(write).toHaveBeenCalledOnce();
  expect(String(write.mock.calls[0]?.[0]).includes(deviceNotification.userCode)).toBe(true);
  terminal.stderr.isTTY = false;
  expect(() => render(deviceNotification)).toThrow("interactive, unrecorded terminal");
  expect(write).toHaveBeenCalledOnce();
});

it.each(["timeout", "cancel", "pre_cancel"])("retains device login deadline/cancellation semantics: %s", async (kind) => {
  vi.useFakeTimers();
  const f = await fixture();
  f.login.mockImplementation(() => new Promise(() => {}));
  if (kind === "pre_cancel") f.cancellation.abort();
  const running = runLiveCodex("auth_only", f.interaction);
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(LIVE_LIMITS.loginMs);
  else f.cancellation.abort();
  const result = await running;
  expect(result.authentication).toEqual(kind === "timeout" ?
    { outcome: "unconfirmed", oauthFailureCategory: "oauth_timeout" } :
    { outcome: "failed", oauthFailureCategory: "unknown" });
  if (kind === "pre_cancel") expect(f.login).not.toHaveBeenCalled();
  expect(f.stream).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.skipIf(process.platform !== "win32")("compiled captured mode refuses login and exclusive reservation preserves browser and device evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "tesota-device-reserve-"));
  try {
    mkdirSync(join(directory, "experiments/codex/evidence"), { recursive: true });
    const browserPath = join(directory, "experiments/codex/evidence/browser-auth.json");
    const devicePath = join(directory, "experiments/codex/evidence/device-auth.json");
    const historical = readFileSync("experiments/codex/evidence/browser-auth.json");
    writeFileSync(browserPath, historical);
    const invoke = (captured: boolean) => spawnSync("bun", ["--no-env-file", "--preload",
      resolve("tests/fixtures/auth-only-smoke.mjs"), resolve("dist/live-codex.js"), "--auth-only", "--device-code"], {
      cwd: directory, encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], TESOTA_TEST_CAPTURED: captured ? "1" : "0" },
    });
    const captured = invoke(true);
    expect(captured.status).toBe(2);
    expect(captured.stderr).toContain("captured execution is disabled");
    expect(() => readFileSync(devicePath)).toThrow();
    const first = invoke(false);
    expect(first.status).toBe(0);
    expect((first.stdout + first.stderr).includes(deviceNotification.userCode)).toBe(false);
    const runs = join(directory, "experiments/codex/runs");
    const [runFile] = readdirSync(runs);
    if (runFile === undefined) throw new Error("Expected one retained run");
    const firstPath = join(runs, runFile);
    const record = readFileSync(firstPath);
    expect(JSON.parse(record.toString())).toMatchObject({ authenticationMethod: "device_code", modelInvocationCount: 0 });
    expect(invoke(false).status).toBe(0);
    expect(readdirSync(runs)).toHaveLength(2);
    expect(readFileSync(firstPath).equals(record)).toBe(true);
    expect(readFileSync(browserPath).equals(historical)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("public Pi device-unavailable failure stays unknown and never falls back", async () => {
  const f = await fixture();
  f.login.mockRestore();
  const fetch = vi.fn(async () => new Response("SYNTHETIC_PRIVATE", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const render = vi.fn();
  const result = await runLiveCodex("auth_only", deviceCodeAuth(render, f.cancellation.signal));
  expect(fetch).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ authentication: { outcome: "failed", oauthFailureCategory: "unknown" },
    disposition: "failed", experiment: null });
  expect(render).not.toHaveBeenCalled();
  expect(f.stream).not.toHaveBeenCalled();
  expect(JSON.stringify(evidence(result)).includes("SYNTHETIC_PRIVATE")).toBe(false);
});

it("late device notifications cannot display a code after the application deadline", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const render = vi.fn();
  let notify: (() => void) | undefined;
  f.login.mockImplementation(async (_provider, _type, interaction) => {
    await interaction.prompt(selection);
    notify = () => interaction.notify(deviceNotification);
    return new Promise(() => {});
  });
  const running = runLiveCodex("auth_only", deviceCodeAuth(render, f.cancellation.signal));
  await vi.advanceTimersByTimeAsync(LIVE_LIMITS.loginMs);
  expect((await running).authentication.outcome).toBe("unconfirmed");
  expect(notify).toBeDefined();
  expect(() => notify?.()).toThrow("Login interaction closed");
  expect(render).not.toHaveBeenCalled();
});

it.each([["--auth-only"], ["--full-probe", "--unknown"], ["--full-probe", "--device-code", "extra"], ["--device-code"], []].map((args) => ({ args })))(
  "compiled CLI requires the exact explicit mode/method combination (%#)", ({ args }) => {
    const result = spawnSync("bun", ["--no-env-file", "--preload", resolve("tests/fixtures/auth-only-smoke.mjs"),
      resolve("dist/live-codex.js"), ...args], { encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], TESOTA_TEST_SCENARIO: "forbid_login" } });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Select --auth-only --device-code or --full-probe");
    expect(result.stdout + result.stderr).not.toContain("LOGIN_MUST_NOT_START");
  },
);

it.skipIf(process.platform !== "win32").each([
  ["success", 0, 2], ["login_failure", 1, 0], ["login_timeout", 1, 0],
  ["normal_failure", 1, 1], ["abort_failure", 1, 2], ["normal_tool", 1, 1], ["abort_tool", 1, 2],
] as const)("compiled full-probe/device-code composition: %s", (scenario, exit, count) => {
  const directory = mkdtempSync(join(tmpdir(), "tesota-full-device-"));
  try {
    mkdirSync(join(directory, "experiments/codex/evidence"), { recursive: true });
    const result = spawnSync("bun", ["--no-env-file", "--preload", resolve("tests/fixtures/auth-only-smoke.mjs"),
      resolve("dist/live-codex.js"), "--full-probe", "--device-code"], {
      cwd: directory, encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], TESOTA_TEST_SCENARIO: scenario },
    });
    expect(result.status).toBe(exit);
    expect(result.stdout).toContain("device-code OAuth/network authentication AND up to two model invocations");
    const runs = join(directory, "experiments/codex/runs");
    const [runFile] = readdirSync(runs);
    if (runFile === undefined) throw new Error("Expected one retained run");
    const serialized = readFileSync(join(runs, runFile), "utf8");
    const record = JSON.parse(serialized);
    expect(record).toMatchObject({ format: "tesota-codex-evidence", version: 9, mode: "full_probe", authenticationMethod: "device_code",
      authenticationOutcome: scenario === "login_failure" ? "failed" : scenario === "login_timeout" ? "unconfirmed" : "succeeded",
      modelInvocationCount: count, disposition: exit === 0 ? "passed" : "failed" });
    for (const secret of ["TEST-ONLY", "SYNTHETIC_PRIVATE"]) {
      expect(serialized + result.stdout + result.stderr).not.toContain(secret);
    }
    if (count === 0) expect([record.turn, record.abortProbe]).toEqual([null, null]);
    else {
      expect(record.turn.modelInvocationCount).toBe(1);
      expect(record.turn.taskAcceptance).toBe("not_evaluated");
      if (count === 1) expect(record.abortProbe).toBeNull();
      else {
        expect(record.turn.disposition).toBe("passed");
        expect(record.abortProbe.modelInvocationCount).toBe(1);
        expect(record.abortProbe.taskAcceptance).toBe("not_evaluated");
        expect(record.abortProbe.disposition).toBe(exit === 0 ? "passed" : "failed");
      }
      if (scenario.endsWith("_tool")) {
        expect(scenario === "normal_tool" ? record.turn : record.abortProbe).toMatchObject({
          invocationAttempts: 2, requestBudgetExceeded: true, toolExecutionStartCount: 1, disposition: "failed",
        });
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== "win32")("compiled device full-probe checks terminal and reservation before login, preserving prior evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "tesota-full-reserve-"));
  const historical = ["browser-probe.json", "browser-auth.json", "device-auth.json"]
    .map((name) => ({ name, bytes: readFileSync(join("experiments/codex/evidence", name)) }));
  try {
    mkdirSync(join(directory, "experiments/codex/evidence"), { recursive: true });
    for (const file of historical) writeFileSync(join(directory, "experiments/codex/evidence", file.name), file.bytes);
    const destination = join(directory, "experiments/codex/evidence/device-probe.json");
    const invoke = (captured: boolean) => spawnSync("bun", ["--no-env-file", "--preload",
      resolve("tests/fixtures/auth-only-smoke.mjs"), resolve("dist/live-codex.js"), "--full-probe", "--device-code"], {
      cwd: directory, encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"],
        TESOTA_TEST_CAPTURED: captured ? "1" : "0", TESOTA_TEST_SCENARIO: "forbid_login" },
    });
    const captured = invoke(true);
    expect(captured.status).toBe(2);
    expect(captured.stderr).toContain("captured execution is disabled");
    expect(() => readFileSync(destination)).toThrow();
    const reserved = Buffer.from("existing reservation\n");
    writeFileSync(destination, reserved);
    // A non-directory runs path prevents exclusive output reservation before login.
    writeFileSync(join(directory, "experiments/codex/runs"), "blocked");
    const occupied = invoke(false);
    expect(occupied.status).toBe(1);
    expect(occupied.stderr).toContain("Codex experiment failed");
    for (const result of [captured, occupied]) expect(result.stdout + result.stderr).not.toContain("LOGIN_MUST_NOT_START");
    expect(readFileSync(destination)).toEqual(reserved);
    for (const file of historical) {
      expect(readFileSync(join(directory, "experiments/codex/evidence", file.name))).toEqual(file.bytes);
      expect(readFileSync(join("experiments/codex/evidence", file.name))).toEqual(file.bytes);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("new package command exposes explicit device full-probe selection and offline help", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  expect(manifest.scripts["live:codex:device-code"]).toBe("bun --no-env-file dist/live-codex.js --full-probe --device-code");
  const output = execFileSync("bun", ["run", "live:codex:device-code", "--help"], {
    encoding: "utf8", timeout: 5_000, windowsHide: true,
  });
  expect(output).toContain("--full-probe --device-code performs network authentication AND up to two model invocations");
});
