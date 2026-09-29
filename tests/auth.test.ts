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
  const shown = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  // Each status prints a table; its second line is the route's own row.
  const row = (): string => String(shown.mock.calls.at(-1)?.[0] ?? "").split("\n")[1] ?? "";
  try {
    const store = new TesotaCredentials(join(root, "auth"));
    expect(await runAuthCommand("status", "opencode", store)).toBe(0);
    expect(row()).toMatch(/^opencode {2}OpenCode {2}no key: tesota auth login opencode/u);
    await store.modify("openrouter", async () => ({ type: "oauth", access: "TEST_ISSUED_KEY", refresh: "", expires: Number.MAX_SAFE_INTEGER }));
    await store.modify("opencode-go", async () => ({ type: "api_key", key: "TEST_OPENCODE_KEY" }));
    expect(await runAuthCommand("status", "openrouter", store)).toBe(0);
    expect(row()).toMatch(/^openrouter {2}OpenRouter {2}key saved from your sign-in/u);
    expect(await runAuthCommand("status", "opencode", store)).toBe(0);
    expect(row()).toMatch(/^opencode {2}OpenCode {2}key saved, for Zen and Go/u);
    expect(await runAuthCommand("logout", "opencode", store)).toBe(0);
    expect(await store.read("opencode-go")).toBeUndefined();
    expect(said.mock.calls.map((call) => String(call[0]))).toEqual(["OpenCode (Zen and Go): saved key removed."]);
    const output = [...said.mock.calls, ...shown.mock.calls].map((call) => String(call[0])).join("\n");
    expect(output).not.toContain("TEST_");
    expect(await runAuthCommand("status", "gemini", store)).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
