import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceId, readSettings, updateSettings, writeSettings } from "../src/settings.ts";

/** The operator's settings (#443), always in a temporary folder. */
const fileIn = (): string => join(mkdtempSync(join(tmpdir(), "tesota-core-settings-")), "settings.json");

describe("the settings file", () => {
  test("named accounts survive only valid, unambiguous declarations", () => {
    const path = fileIn();
    const accounts = [{ name: "b", provider: "claude-code", folder: join(tmpdir(), "claude-b") },
      { name: "work", provider: "openai-codex" }] as const;
    writeFileSync(path, JSON.stringify({ accounts }));
    expect(readSettings(path)).toEqual({ settings: { accounts }, invalid: [] });
    for (const bad of [[{ name: "a/b", provider: "openai-codex" }], [{ name: "b", provider: "claude-code" }],
      [{ name: "b", provider: "other" }], [accounts[1], accounts[1]], [{ name: "b", provider: "claude-code", folder: "relative" }]]) {
      writeFileSync(path, JSON.stringify({ accounts: bad }));
      expect(readSettings(path)).toEqual({ settings: {}, invalid: ["accounts"] });
    }
  });

  test("verification model settings persist and reject malformed selections (#709)", () => {
    const path = fileIn();
    for (const openCasesModel of ["openrouter/vendor/model", "off"]) {
      writeFileSync(path, JSON.stringify({ openCasesModel, claimcheckModel: "anthropic/claude-sonnet-5-5" }));
      expect(readSettings(path)).toEqual({ settings: { openCasesModel, claimcheckModel: "anthropic/claude-sonnet-5-5" }, invalid: [] });
    }
    for (const invalid of ["", "no-slash", "provider/", "provider/has space", 42, null]) {
      writeFileSync(path, JSON.stringify({ openCasesModel: invalid, claimcheckModel: invalid }));
      expect(readSettings(path)).toEqual({ settings: {}, invalid: ["openCasesModel", "claimcheckModel"] });
    }
    writeFileSync(path, JSON.stringify({ claimcheckModel: "off" }));
    expect(readSettings(path)).toEqual({ settings: {}, invalid: ["claimcheckModel"] });
  });

  test("no file means no settings", () => {
    expect(readSettings(fileIn())).toEqual({ settings: {}, invalid: [] });
  });

  test("the model, thinking level and terminal mode survive a re-read", () => {
    const path = fileIn();
    writeSettings({ model: "anthropic/claude-sonnet-5-5", thinkingLevel: "high", tuiMode: "inline" }, path);
    expect(readSettings(path)).toEqual({ settings: { model: "anthropic/claude-sonnet-5-5", thinkingLevel: "high", tuiMode: "inline" },
      invalid: [] });
  });

  test("an invalid value is left out and named, and the rest still reads", () => {
    const path = fileIn();
    writeFileSync(path, JSON.stringify({ model: "no-slash", thinkingLevel: "loud", tuiMode: "fullscreen", agentLimit: 17, other: 1 }));
    expect(readSettings(path)).toEqual({ settings: { tuiMode: "fullscreen" }, invalid: ["model", "thinkingLevel", "agentLimit"] });
  });

  test("a file that begins with a byte-order mark, as Windows PowerShell 5.1 writes one, reads as any other (#470)", () => {
    const path = fileIn();
    writeFileSync(path, `\uFEFF${JSON.stringify({ model: "openai/gpt-6-sol", permissionMode: "full" })}`);
    expect(readSettings(path)).toEqual({ settings: { model: "openai/gpt-6-sol", permissionMode: "full" }, invalid: [] });
  });

  test("a file that is not JSON is a failure, never read as empty", () => {
    const path = fileIn();
    writeFileSync(path, "{ not json");
    expect(() => readSettings(path)).toThrow();
  });

  test("saving a setting, an account or the installation's id keeps the rest of the file as written: hooks, invalid and unknown keys (#642)", () => {
    const path = fileIn();
    const others = { hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "lint" }] }] }, agentLimit: 17, future: { kept: true } };
    writeFileSync(path, JSON.stringify({ ...others, model: "openai/gpt-6-sol" }));
    updateSettings({ permissionMode: "full" }, path);
    updateSettings((current) => ({ accounts: [...current.accounts ?? [], { name: "work", provider: "openai-codex" }] }), path);
    const id = deviceId(path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...others, model: "openai/gpt-6-sol", permissionMode: "full",
      accounts: [{ name: "work", provider: "openai-codex" }], deviceId: id });
  });

  test("the installation's id is made once and kept, beside the other settings", () => {
    const path = fileIn();
    writeSettings({ tuiMode: "inline" }, path);
    const id = deviceId(path);
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    // A first login's id, before the folder exists.
    const fresh = join(mkdtempSync(join(tmpdir(), "tesota-core-settings-")), "home", "settings.json");
    expect(readSettings(fresh).settings.deviceId).toBeUndefined();
    expect(deviceId(fresh)).toBe(deviceId(fresh));
    expect(deviceId(path)).toBe(id);
    expect(readSettings(path).settings).toEqual({ tuiMode: "inline", deviceId: id });
  });
});
