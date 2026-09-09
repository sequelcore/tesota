import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { runLiveCodex, browserOnlyAuth, observeLiveBrowserLaunch, LIVE_LIMITS,
  LIVE_CODEX_EXPECTED_TOKEN, type LiveCodexRunResult } from "../src/integrations/pi-live.js";
import { liveSourceIdentity, serializeLiveEvidence, type LiveSourceIdentity } from "../src/integrations/pi-live-evidence.js";

// Real locked Models instance; only login and provider stream dispatch are synthetic.
const harness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@earendil-works/pi-ai", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, createModels: () => harness.create() };
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

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
  const interaction = browserOnlyAuth(vi.fn(), cancellation.signal);
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
  expect(result).toEqual({ mode: "auth_only", authentication: { outcome: "succeeded", oauthFailureCategory: null },
    experiment: null, inferenceAttempted: false, disposition: "succeeded" });
  expect(f.login).toHaveBeenCalledOnce();
  expect(f.stream).not.toHaveBeenCalled();
  expect(lookup).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
  const record = evidence(result);
  expect(record).toMatchObject({ version: 3, mode: "auth_only", authenticationOutcome: "succeeded",
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
  const run: LiveCodexRunResult = { mode: "auth_only", authentication: { outcome: "succeeded", oauthFailureCategory: null },
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
  const output = execFileSync("bun", ["--no-env-file", "dist/live-codex.js", "--auth-only", "--help"], {
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
      resolve("dist/live-codex.js"), "--auth-only"], {
      cwd: directory, encoding: "utf8", timeout: 5_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"] },
    });
    expect(output).toContain("ZERO model inference calls");
    const record = JSON.parse(readFileSync(join(directory, "docs/m31a-auth-only-evidence.json"), "utf8"));
    expect(record).toMatchObject({ mode: "auth_only", authenticationOutcome: "succeeded",
      modelInvocationCount: 0, turn: null, abortProbe: null, disposition: "succeeded" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
