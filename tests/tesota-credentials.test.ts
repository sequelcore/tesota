import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

const provider = "openai-codex";
const secret: OAuthCredential = { type: "oauth", access: "TEST_ACCESS", refresh: "TEST_REFRESH", expires: 0, accountId: "TEST_ACCOUNT" };

it("compiled login persists across processes, status is sanitized, and logout removes only Tesota login", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-auth-cli-"));
  try {
    const invoke = (action: string) => spawnSync("bun", ["--no-env-file", "--preload",
      resolve("tests/fixtures/persistent-auth-smoke.mjs"), resolve("dist/cli.js"), "auth", action], {
      encoding: "utf8", timeout: 8_000, windowsHide: true,
      env: { PATH: process.env["PATH"], SystemRoot: process.env["SystemRoot"], TESOTA_TEST_AUTH_DIRECTORY: join(root, "auth") },
    });
    const operations: readonly (readonly [string, string])[] = [
      ["login", "login saved"], ["status", "saved login available"],
      ["login", "already logged in"], ["logout", "credentials removed"], ["status", "logged out"],
    ];
    for (const [action, expected] of operations) {
      const result = invoke(action);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(expected);
      expect(result.stdout + result.stderr).not.toMatch(/SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|NETWORK_FORBIDDEN/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

it("persists OAuth across instances, lists only metadata, and deletes through Pi logout", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-auth-"));
  try {
    const first = new TesotaCredentials(join(root, "auth"));
    await first.modify(provider, async () => secret);
    const next = new TesotaCredentials(join(root, "auth"));
    expect(await next.read(provider)).toEqual(secret);
    expect(await next.list()).toEqual([{ providerId: provider, type: "oauth" }]);
    const models = createModels({ credentials: next });
    models.setProvider(openaiCodexProvider());
    await models.logout(provider);
    expect(await first.read(provider)).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("serializes Pi refresh across independent stores and preserves credentials on failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-refresh-"));
  try {
    const first = new TesotaCredentials(join(root, "auth"));
    await first.modify(provider, async () => secret);
    const refresh = vi.fn(async () => ({ ...secret, access: "ROTATED_ACCESS", expires: Date.now() + 3_600_000 }));
    const instances = [first, new TesotaCredentials(join(root, "auth"))].map((credentials) => {
      const models = createModels({ credentials });
      const codex = openaiCodexProvider();
      const oauth = codex.auth.oauth;
      if (oauth === undefined) throw new Error("Expected Codex OAuth support");
      oauth.refresh = refresh;
      models.setProvider(codex);
      return models;
    });
    await Promise.all(instances.map((models) => models.getAuth(provider)));
    expect(refresh).toHaveBeenCalledOnce();
    expect(await first.read(provider)).toMatchObject({ access: "ROTATED_ACCESS" });
    const before = await readFile(join(root, "auth/codex.json"));
    await expect(first.modify(provider, async () => { throw new Error("TEST_FAILURE"); })).rejects.toThrow();
    expect(await readFile(join(root, "auth/codex.json"))).toEqual(before);
    await expect(first.modify(provider, async () => ({ ...secret, access: "x".repeat(70_000) }))).rejects.toThrow("bound");
    expect(await readFile(join(root, "auth/codex.json"))).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("rejects foreign providers, corrupt records and cancelled writes without leaking stored text", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-corrupt-auth-"));
  try {
    const store = new TesotaCredentials(join(root, "auth"));
    await expect(store.modify("another-provider", async () => secret)).rejects.toThrow("Unsupported");
    await store.modify(provider, async () => secret);
    const cancel = new AbortController();
    await expect(store.modify(provider, async () => { cancel.abort(); return { ...secret, access: "NEW" }; },
      { signal: cancel.signal })).rejects.toThrow();
    expect(await store.read(provider)).toEqual(secret);
    await writeFile(join(root, "auth/codex.json"), "TEST_SECRET_BROKEN_JSON");
    await expect(store.read(provider)).rejects.toThrow("Cannot read Tesota credentials");
    await expect(store.read(provider)).rejects.not.toThrow("TEST_SECRET");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps an Anthropic API key beside the Codex login, and never accepts a claude.ai OAuth credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-anthropic-auth-"));
  try {
    const store = new TesotaCredentials(join(root, "auth"));
    await expect(store.modify("anthropic", async () => ({ type: "oauth", access: "A", refresh: "R", expires: 0 })))
      .rejects.toThrow("Only an Anthropic API key can be stored");
    await expect(store.modify(provider, async () => ({ type: "api_key", key: "KEY" }))).rejects.toThrow("Only valid Codex OAuth");
    await expect(store.modify("anthropic", async () => ({ type: "api_key", key: " " }))).rejects.toThrow();
    await store.modify("anthropic", async () => ({ type: "api_key", key: "TEST_ANTHROPIC_KEY" }));
    await store.modify(provider, async () => secret);
    const next = new TesotaCredentials(join(root, "auth"));
    expect(await next.read("anthropic")).toEqual({ type: "api_key", key: "TEST_ANTHROPIC_KEY" });
    expect(await next.list()).toEqual([{ providerId: provider, type: "oauth" }, { providerId: "anthropic", type: "api_key" }]);
    await next.delete("anthropic");
    expect(await next.read("anthropic")).toBeUndefined();
    expect(await next.read(provider)).toEqual(secret);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("keeps an OpenRouter key or its browser sign-in, and one OpenCode key for Zen and Go", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-gateway-auth-"));
  try {
    const store = new TesotaCredentials(join(root, "auth"));
    // OpenRouter's sign-in issues a lasting key, which Pi keeps as an OAuth credential with no refresh token.
    const signedIn: OAuthCredential = { type: "oauth", access: "TEST_OPENROUTER_KEY", refresh: "", expires: Number.MAX_SAFE_INTEGER };
    await store.modify("openrouter", async () => signedIn);
    expect(await store.read("openrouter")).toEqual(signedIn);
    await store.modify("openrouter", async () => ({ type: "api_key", key: "TEST_PASTED_KEY" }));
    await expect(store.modify("openrouter", async () => ({ type: "oauth", access: "", refresh: "", expires: 0 }))).rejects.toThrow();
    await expect(store.modify("opencode", async () => signedIn)).rejects.toThrow("Only an OpenCode API key can be stored");
    await store.modify("opencode-go", async () => ({ type: "api_key", key: "TEST_OPENCODE_KEY" }));
    expect(await store.read("opencode")).toEqual({ type: "api_key", key: "TEST_OPENCODE_KEY" });
    expect(await readFile(join(root, "auth/opencode.json"), "utf8")).toContain("TEST_OPENCODE_KEY");
    await store.delete("opencode");
    expect(await store.read("opencode-go")).toBeUndefined();
    expect(await store.read("openrouter")).toEqual({ type: "api_key", key: "TEST_PASTED_KEY" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
