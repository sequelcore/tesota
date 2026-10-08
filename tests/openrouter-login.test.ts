import { get } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { browserSignInAuth, loginToOpenRouter, OPENROUTER_SIGN_IN } from "../src/integrations/pi-login.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

/**
 * OpenRouter's sign-in (decision 031) through Pi's own PKCE flow: a real
 * loopback callback and Pi's code exchange; only OpenRouter's key endpoint
 * is synthetic.
 */

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function store(): Promise<TesotaCredentials> {
  const root = await mkdtemp(join(tmpdir(), "tesota-openrouter-login-"));
  roots.push(root);
  return new TesotaCredentials(join(root, "auth"));
}

/** OpenRouter's key endpoint: a code and its PKCE verifier for a lasting key. */
function keyEndpoint(): ReturnType<typeof vi.fn> {
  const exchange = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) !== "https://openrouter.ai/api/v1/auth/keys") throw new Error("Unexpected offline route");
    const body = JSON.parse(String(init?.body)) as { code: string; code_verifier: string };
    expect(body.code).toBe("TEST_CODE");
    expect(body.code_verifier.length).toBeGreaterThan(40);
    return Response.json({ key: "TEST_ISSUED_KEY" });
  });
  vi.stubGlobal("fetch", exchange);
  return exchange;
}

/** The browser: OpenRouter redirects it to the loopback callback with the code. */
function browserReturning(code: string): (url: string) => void {
  return (url) => {
    const callback = new URL(new URL(url).searchParams.get("callback_url") ?? "");
    callback.searchParams.set("code", code);
    get(callback, (response) => { response.resume(); });
  };
}

it("signs in through the browser and keeps OpenRouter's key, without asking for a paste", async () => {
  const credentials = await store();
  const exchange = keyEndpoint();
  const shown: string[] = [];
  const pasted = vi.fn((_prompt: string, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener("abort", () => { reject(new DOMException("cancelled", "AbortError")); }, { once: true });
  }));
  const auth = browserSignInAuth(OPENROUTER_SIGN_IN, { open: browserReturning("TEST_CODE"), write: (text) => { shown.push(text); }, readLine: pasted },
    new AbortController().signal);
  expect(await loginToOpenRouter(auth, credentials)).toBe("succeeded");
  expect(exchange).toHaveBeenCalledOnce();
  expect(await credentials.read("openrouter")).toEqual({ type: "oauth", access: "TEST_ISSUED_KEY", refresh: "",
    expires: Number.MAX_SAFE_INTEGER });
  expect(shown.join("")).toMatch(/^Sign in with OpenRouter in your browser\. If it does not open, go to:\nhttps:\/\/openrouter\.ai\/auth\?/u);
  expect(shown.join("")).not.toContain("TEST_");
  // The paste prompt was offered, then withdrawn once the browser returned.
  expect(pasted).toHaveBeenCalledOnce();
  expect(pasted.mock.calls[0]?.[1].aborted).toBe(true);
});

it("takes the address the browser ended on when it cannot reach this computer", async () => {
  const credentials = await store();
  keyEndpoint();
  const auth = browserSignInAuth(OPENROUTER_SIGN_IN, { open: () => { throw new Error("no browser here"); }, write: () => {},
    readLine: async () => "http://127.0.0.1:1/oauth/callback/x?code=TEST_CODE" }, new AbortController().signal);
  expect(await loginToOpenRouter(auth, credentials)).toBe("succeeded");
  expect(await credentials.read("openrouter")).toMatchObject({ access: "TEST_ISSUED_KEY" });
});

it("refuses a sign-in address that is not OpenRouter's, and saves nothing", async () => {
  const credentials = await store();
  const opened = vi.fn();
  const auth = browserSignInAuth(OPENROUTER_SIGN_IN, { open: opened, write: () => {}, readLine: async () => "" }, new AbortController().signal);
  expect(() => { auth.notify({ type: "auth_url", url: "https://openrouter.example/auth?callback_url=x" }); }).toThrow();
  expect(opened).not.toHaveBeenCalled();
  expect(await credentials.read("openrouter")).toBeUndefined();
});
