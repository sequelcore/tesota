import { expect, it } from "vitest";
import { win32 } from "node:path";
import { openBrowser } from "../src/model-view-process.js";

it.each(["win32", "darwin", "linux"] as const)("opens %s files with an argument array, never a path interpolated into a shell string", async platform => {
  const calls: { file: string; args: readonly string[] }[] = [];
  const path = 'C:/capture with spaces/&$(bad).html';
  await openBrowser(path, platform, async (file, args) => { calls.push({ file, args }); });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args.filter(a => a === path)).toHaveLength(1);
  expect(calls[0]?.file).toBe(platform === "win32" ? win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "explorer.exe") : platform === "darwin" ? "/usr/bin/open" : "xdg-open");
  expect(calls[0]?.args).toEqual([path]);
});

it.each([
  ["win32", win32.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", "https://example.test/oauth?a=1&b=2"]],
  ["darwin", "/usr/bin/open", ["https://example.test/oauth?a=1&b=2"]],
  ["linux", "xdg-open", ["https://example.test/oauth?a=1&b=2"]],
] as const)("opens %s sign-in URLs without shell parsing", async (platform, file, args) => {
  const calls: { file: string; args: readonly string[] }[] = [];
  await openBrowser("https://example.test/oauth?a=1&b=2", platform, async (file, args) => { calls.push({ file, args }); });
  expect(calls).toEqual([{ file, args }]);
});
