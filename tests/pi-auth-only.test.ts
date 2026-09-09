import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runLiveCodex, deviceCodeAuth, deviceCodeTerminalRenderer, browserOnlyAuth, observeLiveBrowserLaunch, LIVE_LIMITS,
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
  expect(record).toMatchObject({ version: 4, mode: "auth_only", authenticationOutcome: "succeeded",
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
  const result = await runLiveCodex("full_probe", browserOnlyAuth(vi.fn(), f.cancellation.signal));
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

it.each(["timeout_first", "browser_first"])("settles timeout/browser race by first local observation: %s", async (order) => {
  vi.useFakeTimers();
  const f = await fixture();
  let failBrowser: () => void = () => {};
  observeLiveBrowserLaunch((failed) => { failBrowser = failed; }, f.cancellation);
  f.login.mockImplementation(() => new Promise(() => {}));
  if (order === "browser_first") setTimeout(failBrowser, LIVE_LIMITS.loginMs);
  const running = runLiveCodex("auth_only", f.interaction);
  if (order === "timeout_first") setTimeout(failBrowser, LIVE_LIMITS.loginMs);
  // Synchronous timer advancement deliberately withholds promise microtasks.
  vi.advanceTimersByTime(LIVE_LIMITS.loginMs);
  const result = await running;
  expect(result.authentication).toEqual(order === "timeout_first" ?
    { outcome: "unconfirmed", oauthFailureCategory: "oauth_timeout" } :
    { outcome: "failed", oauthFailureCategory: "browser_launch_failed" });
  expect(evidence(result)).toMatchObject({ disposition: "failed", modelInvocationCount: 0, turn: null, abortProbe: null });
  expect(f.stream).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

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
  expect(Object.keys(identity)).toHaveLength(10);
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
  expect(output).toContain("ZERO model inference calls; no M3.1a probes");
  expect(output).toContain("network authentication");
});

it.skipIf(process.platform !== "win32")("compiled AUTH-ONLY exits with sanitized durable success using offline login", () => {
  const directory = mkdtempSync(join(tmpdir(), "tesota-auth-smoke-"));
  try {
    mkdirSync(join(directory, "docs"));
    const output = execFileSync("bun", ["--no-env-file", "--preload", resolve("tests/fixtures/auth-only-smoke.mjs"),
      resolve("dist/live-codex.js"), "--auth-only", "--device-code"], {
      cwd: directory, encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
    });
    expect(output).toContain("ZERO model inference calls");
    const record = JSON.parse(readFileSync(join(directory, "docs/m31a-auth-only-device-code-evidence.json"), "utf8"));
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

it("uses the real public Pi Models.login selection, notification, polling and exchange with synthetic fetch", async () => {
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
  const result = await runLiveCodex("auth_only", auth);
  expect(result).toMatchObject({ authenticationMethod: "device_code", disposition: "succeeded", experiment: null });
  expect(prompt).toHaveBeenCalledOnce();
  expect(prompt.mock.calls[0]?.[0]).toMatchObject({ type: "select", options: expect.arrayContaining([
    expect.objectContaining({ id: "device_code" }),
  ]) });
  expect(await prompt.mock.results[0]?.value).toBe("device_code");
  expect(routes).toEqual(["https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token", "https://auth.openai.com/oauth/token"]);
  expect(render).toHaveBeenCalledOnce();
  expect(f.stream).not.toHaveBeenCalled();
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
    mkdirSync(join(directory, "docs"));
    const browserPath = join(directory, "docs/m31a-auth-only-evidence.json");
    const devicePath = join(directory, "docs/m31a-auth-only-device-code-evidence.json");
    const historical = readFileSync("docs/m31a-auth-only-evidence.json");
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
    const record = readFileSync(devicePath);
    expect(JSON.parse(record.toString())).toMatchObject({ authenticationMethod: "device_code", modelInvocationCount: 0 });
    expect(invoke(false).status).not.toBe(0);
    expect(readFileSync(devicePath).equals(record)).toBe(true);
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

it.each([["--auth-only"], ["--full-probe", "--device-code"], ["--device-code"], []].map((args) => ({ args })))(
  "compiled CLI requires the exact explicit mode/method combination (%#)", ({ args }) => {
    const result = spawnSync("bun", ["--no-env-file", "--preload", resolve("tests/fixtures/auth-only-smoke.mjs"),
      resolve("dist/live-codex.js"), ...args], { encoding: "utf8", timeout: 5_000, windowsHide: true });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Select --auth-only --device-code or --full-probe");
  },
);
