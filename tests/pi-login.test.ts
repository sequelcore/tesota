import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { browserSignInAuth, CHATGPT_SIGN_IN, LOGIN_TIME_LIMIT_MS, loginToChatGPT } from "../src/integrations/pi-login.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

// A real Pi model registry; only the login and the network are synthetic.
const harness = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@earendil-works/pi-ai", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, createModels: (...args: unknown[]) => harness.create(...args) };
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

const DEVICE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const silentTerminal = { open: () => {}, write: () => {}, readLine: () => new Promise<string>(() => {}) };

async function fixture() {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  const models = actual.createModels();
  harness.create.mockReturnValue(models);
  const login = vi.spyOn(models, "login").mockResolvedValue({ type: "oauth", access: "SYNTHETIC_PRIVATE",
    refresh: "SYNTHETIC_PRIVATE", expires: 0 });
  const cancellation = new AbortController();
  return { models, login, cancellation, interaction: browserSignInAuth(CHATGPT_SIGN_IN, silentTerminal, cancellation.signal) };
}

it("signs in to the route's own provider, naming Tesota and this installation, without looking up a model", async () => {
  const f = await fixture();
  const lookup = vi.spyOn(f.models, "getModel");
  expect(await loginToChatGPT(f.interaction, DEVICE)).toBe("succeeded");
  expect(f.login).toHaveBeenCalledOnce();
  const [provider, type, , options] = f.login.mock.calls[0] ?? [];
  expect([provider, type]).toEqual(["openai", "oauth"]);
  expect(options?.agentName).toBe("Tesota");
  expect(options?.getDeviceId?.()).toBe(DEVICE);
  expect(lookup).not.toHaveBeenCalled();
  // The route signs in only with ChatGPT; an API key is never one of its sign-ins.
  expect(f.models.getProvider("openai")?.auth.apiKey).toBeUndefined();
});

it.each(["stream", "streamSimple", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred"] as const)(
  "fails a login during which %s was attempted, even when the attempt was caught", async (method) => {
    const f = await fixture();
    f.login.mockImplementation(async () => {
      try { Reflect.apply(f.models[method], f.models, []); } catch { /* accidental suppression */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    expect(await loginToChatGPT(f.interaction, DEVICE)).toBe("failed");
  },
);

it.each(["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const)(
  "fails a login during which the provider's %s was reached directly", async (method) => {
    const f = await fixture();
    f.login.mockImplementation(async () => {
      const provider = f.models.getProvider("openai");
      const invoke = provider?.[method];
      expect(invoke).toBeDefined();
      try { if (invoke !== undefined) Reflect.apply(invoke, provider, []); } catch { /* deliberate attempt */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    expect(await loginToChatGPT(f.interaction, DEVICE)).toBe("failed");
  },
);

it("keeps a failed login distinct from success", async () => {
  const f = await fixture();
  f.login.mockRejectedValue(new Error("SYNTHETIC_PRIVATE"));
  expect(await loginToChatGPT(f.interaction, DEVICE)).toBe("failed");
});

it.each(["timeout", "cancel", "pre_cancel"])("stops at the time limit or on cancellation: %s", async (kind) => {
  vi.useFakeTimers();
  const f = await fixture();
  f.login.mockImplementation(() => new Promise(() => {}));
  if (kind === "pre_cancel") f.cancellation.abort();
  const running = loginToChatGPT(f.interaction, DEVICE);
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(LOGIN_TIME_LIMIT_MS);
  else f.cancellation.abort();
  expect(await running).toBe(kind === "timeout" ? "timed_out" : "failed");
  if (kind === "pre_cancel") expect(f.login).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("goes through Pi's own browser sign-in and keeps the client OpenAI issued", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  const root = await mkdtemp(join(tmpdir(), "tesota-chatgpt-login-"));
  roots.push(root);
  const credentials = new TesotaCredentials(join(root, "auth"));
  harness.create.mockImplementation((options: Parameters<typeof actual.createModels>[0]) => actual.createModels(options));
  const tokens = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) !== "https://auth.openai.com/api/accounts/oauth/token") throw new Error("Unexpected offline route");
    const body = new URLSearchParams(String(init?.body));
    expect([body.get("grant_type"), body.get("code"), body.get("client_id")]).toEqual(["authorization_code", "TEST_CODE", "TEST_CLIENT"]);
    return Response.json({ access_token: "TEST_ACCESS", refresh_token: "TEST_REFRESH", id_token: "TEST_ID", expires_in: 3600,
      scope: "openid offline_access chatgpt.tokens.use.direct" });
  });
  vi.stubGlobal("fetch", tokens);
  const shown: string[] = [];
  let opened: URL | undefined;
  // The browser: OpenAI's consent returns to the loopback callback with the code and the client it registered.
  const browser = (url: string): void => {
    opened = new URL(url);
    const callback = new URL(opened.searchParams.get("redirect_uri") ?? "");
    callback.searchParams.set("code", "TEST_CODE");
    callback.searchParams.set("state", opened.searchParams.get("state") ?? "");
    callback.searchParams.set("client_id", "TEST_CLIENT");
    get(callback, (response) => { response.resume(); });
  };
  const auth = browserSignInAuth(CHATGPT_SIGN_IN, { open: browser, write: (text) => { shown.push(text); },
    readLine: (_prompt, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => { reject(new DOMException("cancelled", "AbortError")); }, { once: true });
    }) }, new AbortController().signal);
  expect(await loginToChatGPT(auth, DEVICE, credentials)).toBe("succeeded");
  expect(opened?.searchParams.get("agent_name_hint")).toBe("Tesota");
  expect(opened?.searchParams.get("ext_agent_host_id")).toBe(`urn:uuid:${DEVICE}`);
  expect(tokens).toHaveBeenCalledOnce();
  expect(await credentials.read("openai")).toMatchObject({ type: "oauth", access: "TEST_ACCESS", refresh: "TEST_REFRESH",
    clientId: "TEST_CLIENT" });
  expect(shown.join("")).toMatch(/^Sign in with ChatGPT in your browser\. If it does not open, go to:\nhttps:\/\/auth\.openai\.com\/api\/accounts\/authorize\?/u);
  expect(shown.join("")).not.toContain("TEST_");
});

it.each([
  ["not_granted", { status: 200, scope: "openid offline_access" }, {}],
  ["refused", { status: 400, scope: "" }, {}],
  ["declined", { status: 200, scope: "" }, { error: "access_denied" }],
] as const)("names a sign-in that saved nothing as %s, from Pi's own failure, and saves nothing", async (expected, token, callbackError) => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>("@earendil-works/pi-ai");
  const root = await mkdtemp(join(tmpdir(), "tesota-chatgpt-failure-"));
  roots.push(root);
  const credentials = new TesotaCredentials(join(root, "auth"));
  harness.create.mockImplementation((options: Parameters<typeof actual.createModels>[0]) => actual.createModels(options));
  vi.stubGlobal("fetch", vi.fn(async () => token.status === 200
    ? Response.json({ access_token: "TEST_ACCESS", refresh_token: "TEST_REFRESH", id_token: "TEST_ID", expires_in: 3600, scope: token.scope })
    : new Response("TEST_PROVIDER_TEXT", { status: token.status })));
  const browser = (url: string): void => {
    const opened = new URL(url);
    const callback = new URL(opened.searchParams.get("redirect_uri") ?? "");
    for (const [name, value] of Object.entries({ code: "TEST_CODE", state: opened.searchParams.get("state") ?? "",
      client_id: "TEST_CLIENT", ...callbackError })) callback.searchParams.set(name, value);
    get(callback, (response) => { response.resume(); });
  };
  const auth = browserSignInAuth(CHATGPT_SIGN_IN, { open: browser, write: () => {},
    readLine: (_prompt, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => { reject(new DOMException("cancelled", "AbortError")); }, { once: true });
    }) }, new AbortController().signal);
  expect(await loginToChatGPT(auth, DEVICE, credentials)).toBe(expected);
  expect(await credentials.read("openai")).toBeUndefined();
});

it("refuses a sign-in address that is not OpenAI's", () => {
  const opened = vi.fn();
  const auth = browserSignInAuth(CHATGPT_SIGN_IN, { open: opened, write: () => {}, readLine: async () => "" }, new AbortController().signal);
  expect(() => { auth.notify({ type: "auth_url", url: "https://auth.openai.example/api/accounts/authorize?x=1" }); }).toThrow();
  expect(() => { auth.notify({ type: "auth_url", url: "https://openrouter.ai/auth" }); }).toThrow();
  expect(opened).not.toHaveBeenCalled();
});
