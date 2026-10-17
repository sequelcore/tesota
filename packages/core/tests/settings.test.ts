import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceId, readSettings, writeSettings } from "../src/settings.ts";

/** The operator's settings (#443), always in a temporary folder. */
const fileIn = (): string => join(mkdtempSync(join(tmpdir(), "tesota-core-settings-")), "settings.json");

describe("the settings file", () => {
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
    writeFileSync(path, JSON.stringify({ model: "no-slash", thinkingLevel: "loud", tuiMode: "fullscreen", other: 1 }));
    expect(readSettings(path)).toEqual({ settings: { tuiMode: "fullscreen" }, invalid: ["model", "thinkingLevel"] });
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

  test("the installation's id is made once and kept, beside the other settings", () => {
    const path = fileIn();
    writeSettings({ tuiMode: "inline" }, path);
    const id = deviceId(path);
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(deviceId(path)).toBe(id);
    expect(readSettings(path).settings).toEqual({ tuiMode: "inline", deviceId: id });
  });
});
