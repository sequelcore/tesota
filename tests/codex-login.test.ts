import { afterEach, expect, it, vi } from "vitest";
import { deviceCodeAuth, deviceCodeTerminalRenderer, LOGIN_TIME_LIMIT_MS, loginToCodex } from "../src/integrations/codex-login.js";

// A real Pi model registry; only the login and the network are synthetic.
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
  const cancellation = new AbortController();
  return { models, login, cancellation, interaction: deviceCodeAuth(vi.fn(), cancellation.signal) };
}

const deviceNotification = {
  type: "device_code", verificationUri: "https://auth.openai.com/codex/device",
  userCode: "TEST-ONLY", intervalSeconds: 5, expiresInSeconds: 900,
  deviceAuthId: "SYNTHETIC_PRIVATE", access: "SYNTHETIC_PRIVATE",
} as const;
const selection = { type: "select", message: "offline", options: [
  { id: "browser", label: "Browser" }, { id: "device_code", label: "Device" },
] } as const;

it("logs in without looking up a model", async () => {
  const f = await fixture();
  const lookup = vi.spyOn(f.models, "getModel");
  expect(await loginToCodex(f.interaction)).toBe("succeeded");
  expect(f.login).toHaveBeenCalledOnce();
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["stream", "streamSimple", "complete", "completeSimple", "streamDeferred", "fetchDeferred", "cancelDeferred"] as const)(
  "fails a login during which %s was attempted, even when the attempt was caught", async (method) => {
    const f = await fixture();
    f.login.mockImplementation(async () => {
      try { Reflect.apply(f.models[method], f.models, []); } catch { /* accidental suppression */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    expect(await loginToCodex(f.interaction)).toBe("failed");
  },
);

it.each(["stream", "streamSimple", "fetchDeferred", "cancelDeferred"] as const)(
  "fails a login during which the provider's %s was reached directly", async (method) => {
    const f = await fixture();
    f.login.mockImplementation(async () => {
      const provider = f.models.getProvider("openai-codex");
      const invoke = provider?.[method];
      expect(invoke).toBeDefined();
      try { if (invoke !== undefined) Reflect.apply(invoke, provider, []); } catch { /* deliberate attempt */ }
      return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
    });
    expect(await loginToCodex(f.interaction)).toBe("failed");
  },
);

it("keeps a failed login distinct from success", async () => {
  const f = await fixture();
  f.login.mockRejectedValue(new Error("SYNTHETIC_PRIVATE"));
  expect(await loginToCodex(f.interaction)).toBe("failed");
});

it.each(["timeout", "cancel", "pre_cancel"])("stops at the time limit or on cancellation: %s", async (kind) => {
  vi.useFakeTimers();
  const f = await fixture();
  f.login.mockImplementation(() => new Promise(() => {}));
  if (kind === "pre_cancel") f.cancellation.abort();
  const running = loginToCodex(f.interaction);
  if (kind === "timeout") await vi.advanceTimersByTimeAsync(LOGIN_TIME_LIMIT_MS);
  else f.cancellation.abort();
  expect(await running).toBe(kind === "timeout" ? "timed_out" : "failed");
  if (kind === "pre_cancel") expect(f.login).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("selects device_code and shows only the official address and code, never logging them", async () => {
  const f = await fixture();
  const render = vi.fn();
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  f.login.mockImplementation(async (_provider, _type, interaction) => {
    expect(await interaction.prompt(selection)).toBe("device_code");
    interaction.notify(deviceNotification);
    interaction.notify({ type: "info", message: deviceNotification.userCode });
    interaction.notify({ type: "progress", message: deviceNotification.userCode });
    return { type: "oauth", access: "SYNTHETIC_PRIVATE", refresh: "SYNTHETIC_PRIVATE", expires: 0 };
  });
  expect(await loginToCodex(deviceCodeAuth(render, f.cancellation.signal))).toBe("succeeded");
  expect(f.login).toHaveBeenCalledWith("openai-codex", "oauth", expect.any(Object));
  expect(render).toHaveBeenCalledOnce();
  expect(Object.keys(render.mock.calls[0]?.[0]).sort()).toEqual(["userCode", "verificationUri"]);
  expect(render.mock.calls[0]?.[0]).toEqual({ verificationUri: deviceNotification.verificationUri, userCode: deviceNotification.userCode });
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

it("goes through Pi's own device selection, polling and token exchange", async () => {
  const f = await fixture();
  f.login.mockRestore();
  const render = vi.fn();
  const auth = deviceCodeAuth(render, f.cancellation.signal);
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
  expect(await loginToCodex(auth)).toBe("succeeded");
  expect(routes).toEqual(["https://auth.openai.com/api/accounts/deviceauth/usercode",
    "https://auth.openai.com/api/accounts/deviceauth/token", "https://auth.openai.com/oauth/token"]);
  expect(render).toHaveBeenCalledOnce();
});

it("fails when Pi's device flow is unavailable, without falling back to another method", async () => {
  const f = await fixture();
  f.login.mockRestore();
  const fetch = vi.fn(async () => new Response("SYNTHETIC_PRIVATE", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  const render = vi.fn();
  expect(await loginToCodex(deviceCodeAuth(render, f.cancellation.signal))).toBe("failed");
  expect(fetch).toHaveBeenCalledOnce();
  expect(render).not.toHaveBeenCalled();
});

it.each(["missing_option", "manual_code", "browser_notification", "wrong_uri", "control_code", "repeat"])(
  "rejects an unexpected device interaction, even when the flow catches it: %s", async (kind) => {
    const f = await fixture();
    const render = vi.fn();
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
    expect(await loginToCodex(deviceCodeAuth(render, f.cancellation.signal))).toBe("failed");
    expect(render).not.toHaveBeenCalled();
  },
);

it("cannot show a code that arrives after the time limit", async () => {
  vi.useFakeTimers();
  const f = await fixture();
  const render = vi.fn();
  let notify: (() => void) | undefined;
  f.login.mockImplementation(async (_provider, _type, interaction) => {
    await interaction.prompt(selection);
    notify = () => interaction.notify(deviceNotification);
    return new Promise(() => {});
  });
  const running = loginToCodex(deviceCodeAuth(render, f.cancellation.signal));
  await vi.advanceTimersByTimeAsync(LOGIN_TIME_LIMIT_MS);
  expect(await running).toBe("timed_out");
  expect(() => notify?.()).toThrow("Login interaction closed");
  expect(render).not.toHaveBeenCalled();
});

it("requires every terminal stream before login and again before showing the code", () => {
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
