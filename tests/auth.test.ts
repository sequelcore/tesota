import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runAuthCommand } from "../src/auth.js";
import { TesotaCredentials } from "../src/integrations/tesota-credentials.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("reports and removes the gateway keys, one OpenCode key serving Zen and Go, and never prints a key", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-auth-"));
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENCODE_API_KEY", "");
  const said = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const store = new TesotaCredentials(join(root, "auth"));
    expect(await runAuthCommand("status", "opencode", store)).toBe(0);
    await store.modify("openrouter", async () => ({ type: "oauth", access: "TEST_ISSUED_KEY", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
    await store.modify("opencode-go", async () => ({ type: "api_key", key: "TEST_OPENCODE_KEY" }));
    expect(await runAuthCommand("status", "openrouter", store)).toBe(0);
    expect(await runAuthCommand("status", "opencode", store)).toBe(0);
    expect(await runAuthCommand("logout", "opencode", store)).toBe(0);
    expect(await store.read("opencode-go")).toBeUndefined();
    const output = said.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toBe(["OpenCode (Zen and Go): no key. Run tesota auth login opencode.",
      "OpenRouter: saved key from your sign-in available.", "OpenCode (Zen and Go): saved key available.",
      "OpenCode (Zen and Go): saved key removed."].join("\n"));
    expect(output).not.toContain("TEST_");
    expect(await runAuthCommand("status", "gemini", store)).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
