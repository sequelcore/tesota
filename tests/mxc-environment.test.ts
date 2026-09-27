import { expect, it } from "vitest";
import { type DriveLease, isRunning, onDrive, powershellScript, sandboxToolPaths, sandboxVariables, staleDrives,
  substitutedDrives } from "../src/mxc-environment.js";

/**
 * The native Windows sandbox's own rules (decision 030): what a command may
 * read, where it runs, how its PowerShell script is built, and which variables
 * it receives. The sandbox itself is exercised by `mxc.live.test.ts`.
 */

it("reads the host's tools but never the operator's home or a folder that holds it", () => {
  const home = "C:\\Users\\Ana";
  expect(sandboxToolPaths(["C:\\Program Files\\nodejs", "C:\\Users\\Ana\\.bun\\bin", "C:\\Users", "C:\\", "c:\\users\\ana",
    "C:\\Users\\Ana"], home)).toEqual(["C:\\Program Files\\nodejs", "C:\\Users\\Ana\\.bun\\bin"]);
});

it("reads which drives subst maps, as the command lists them", () => {
  expect(substitutedDrives("T:\\: => C:\\Users\\Ana\\.tesota\\workspaces\\a\\repo\r\nU:\\: => D:\\src\r\n\r\n"))
    .toEqual(new Map([["T", "C:\\Users\\Ana\\.tesota\\workspaces\\a\\repo"], ["U", "D:\\src"]]));
  expect(substitutedDrives("")).toEqual(new Map());
});

it("removes only drives leased to their letter by a process no longer running", async () => {
  const listing = ["T:\\: => C:\\ws\\ended\\repo", "U:\\: => C:\\ws\\running\\repo", "V:\\: => D:\\operator",
    "W:\\: => C:\\ws\\moved\\repo", "X:\\: => C:\\ws\\older\\repo", ""].join("\r\n");
  const leases: Partial<Record<string, DriveLease>> = { "C:\\ws\\ended\\repo": { drive: "t", pid: 10 },
    "C:\\ws\\running\\repo": { drive: "U", pid: 20 }, "C:\\ws\\moved\\repo": { drive: "Z", pid: 30 } };
  const stale = await staleDrives(listing, async (workspace) => leases[workspace], (pid) => pid === 20);
  // V is the operator's own, W's lease names another letter, and X was mapped by a Tesota without leases.
  expect(stale).toEqual(["T"]);
});

it("tells a running process from one that has ended", () => {
  expect(isRunning(process.pid)).toBe(true);
  expect(isRunning(2 ** 31 - 2)).toBe(false);
});

it("runs a command on the workspace's drive, where no folder lies above the workspace", () => {
  expect(onDrive("T", "C:\\ws\\repo", "C:\\ws\\repo")).toBe("T:\\");
  expect(onDrive("T", "C:\\ws\\repo", "C:\\ws\\repo\\packages\\app")).toBe("T:\\packages\\app");
  expect(() => onDrive("T", "C:\\ws\\repo", "C:\\ws\\other")).toThrow("outside the workspace");
});

it("runs a command in its folder, in PowerShell, and exits with the command's own status", () => {
  const script = powershellScript("T:\\it's here", "npm test\nnode -v");
  expect(script).toContain("Set-Location -LiteralPath 'T:\\it''s here'");
  expect(script.indexOf("Set-Location")).toBeLessThan(script.indexOf("npm test\nnode -v"));
  // A native command's non-zero exit, a failed cmdlet, or success, in that order.
  expect(script).toMatch(/\$tesotaOk = \$\?\s*\nexit \$\(if \(\$tesotaOk\) \{ 0 \} elseif \(\$LASTEXITCODE -is \[int\] -and \$LASTEXITCODE -ne 0\) \{ \$LASTEXITCODE \} else \{ 1 \}\)/u);
  expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
});

it("passes only what a command needs: system names, its own folders, the proxy and what it was given", () => {
  const host = { SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", WINDIR: "C:\\Windows", COMSPEC: "C:\\Windows\\system32\\cmd.exe",
    PATHEXT: ".COM;.EXE", PATH: "C:\\Program Files\\nodejs", APPDATA: "C:\\Users\\Ana\\AppData\\Roaming", GITHUB_TOKEN: "secret" };
  const folders = { home: "C:\\ws\\repo.sandbox\\home", temp: "C:\\ws\\repo.sandbox\\tmp", cache: "C:\\cache\\repo", proxy: "http://127.0.0.1:5123" };
  const variables = sandboxVariables(host, folders, { CI: "1" });
  expect(variables).toMatchObject({ SYSTEMROOT: "C:\\Windows", PATH: "C:\\Program Files\\nodejs", CI: "1",
    // Windows requires LOCALAPPDATA to exist; its value is the sandbox's own.
    LOCALAPPDATA: "C:\\ws\\repo.sandbox\\home\\AppData\\Local", APPDATA: "C:\\ws\\repo.sandbox\\home\\AppData\\Roaming",
    USERPROFILE: "C:\\ws\\repo.sandbox\\home", HOME: "C:\\ws\\repo.sandbox\\home", TEMP: "C:\\ws\\repo.sandbox\\tmp",
    HTTPS_PROXY: "http://127.0.0.1:5123", https_proxy: "http://127.0.0.1:5123", npm_config_cache: "C:\\cache\\repo\\npm",
    BUN_INSTALL_CACHE_DIR: "C:\\cache\\repo\\bun",
    // Node would otherwise walk the folders above its own install folder, which the sandbox cannot query.
    NODE_OPTIONS: "--preserve-symlinks --preserve-symlinks-main" });
  // Git uses its own TLS inside the sandbox; Windows' would check revocation on servers the allowlist does not reach.
  expect(variables).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.sslBackend", GIT_CONFIG_VALUE_0: "openssl" });
  expect(variables).not.toHaveProperty("GITHUB_TOKEN");
  expect(Object.values(variables)).not.toContain("C:\\Users\\Ana\\AppData\\Roaming");
  expect(sandboxVariables(host, folders, { NODE_OPTIONS: "--max-old-space-size=4096" })["NODE_OPTIONS"])
    .toBe("--preserve-symlinks --preserve-symlinks-main --max-old-space-size=4096");
});
