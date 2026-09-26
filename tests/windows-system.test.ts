import { copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexCredentials } from "../src/integrations/codex-credentials.js";
import { windowsPowerShell, windowsSystemProgram } from "../src/windows-system.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("names Windows programs by their place in the system directory, and refuses a relative system root", () => {
  vi.stubEnv("SystemRoot", "C:\\Windows");
  expect(windowsSystemProgram("whoami.exe").toLowerCase()).toBe("c:\\windows\\system32\\whoami.exe");
  expect(windowsPowerShell().toLowerCase()).toBe("c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe");
  vi.stubEnv("SystemRoot", "Windows");
  expect(() => windowsSystemProgram("whoami.exe")).toThrow("Cannot locate Windows system directory");
});

it.runIf(process.platform === "win32")("secures the credential directory when another whoami comes first on PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "tesota-system-"));
  roots.push(root);
  // Git Bash puts its own whoami first; any program by that name that is not Windows' own must be ignored.
  copyFileSync(windowsSystemProgram("hostname.exe"), join(root, "whoami.exe"));
  vi.stubEnv("PATH", `${root}${delimiter}${process.env["PATH"] ?? ""}`);
  const store = new CodexCredentials(join(root, "auth"));
  await expect(store.list()).resolves.toEqual([]);
});
