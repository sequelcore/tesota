import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PI_PACKAGE } from "../src/pi-install.js";

// These tests run the built launcher, `dist/cli.js`; `bun run test` builds it first.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-launcher-"));
  roots.push(root);
  return root;
}

/** Runs the launcher, with `path` as its PATH when given. Windows spells the variable `Path`, so every spelling is replaced. */
function tesota(cli: string, args: readonly string[], cwd: string, path?: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => path === undefined || name.toUpperCase() !== "PATH"));
  return spawnSync(process.execPath, [cli, ...args], { cwd, input: "", encoding: "utf8", timeout: 30_000,
    env: path === undefined ? env : { ...env, PATH: path } });
}

it("runs Pi with Tesota's extension loaded and passes the arguments through", () => {
  const result = tesota(resolve("dist/cli.js"), ["--mode", "rpc", "--no-session"], folder());
  expect(result.stderr).toBe("");
  const requests = result.stdout.split("\n").filter((line) => line.startsWith("{")).map((line): unknown => JSON.parse(line));
  expect(requests).toContainEqual(expect.objectContaining({ method: "setStatus", statusKey: "tesota", statusText: "Tesota" }));
  expect(result.status).toBe(0);
}, 30_000);

/** A stub Pi under `root`: it prints the arguments it received and exits with 7. */
function stubPi(root: string, version: string): void {
  mkdirSync(join(root, "node_modules", PI_PACKAGE), { recursive: true });
  writeFileSync(join(root, "node_modules", PI_PACKAGE, "package.json"), JSON.stringify({ name: PI_PACKAGE, version, bin: { pi: "cli.js" } }));
  writeFileSync(join(root, "node_modules", PI_PACKAGE, "cli.js"),
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n");
}

/** A copy of the built package with no Pi beside it, or with a stub Pi of `version`; `src` holds its extension. */
function launcherCopy(version?: string, { src = true } = {}): string {
  const root = folder();
  cpSync("dist", join(root, "dist"), { recursive: true });
  if (src) cpSync("src", join(root, "src"), { recursive: true });
  cpSync("package.json", join(root, "package.json"));
  if (version !== undefined) stubPi(root, version);
  return join(root, "dist", "cli.js");
}

it("refuses to open Pi without Tesota's extension, which Pi would skip without a word", () => {
  const result = tesota(launcherCopy("9.0.0", { src: false }), ["--help"], folder());
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Tesota's installation is incomplete: its Pi extension is missing");
  expect(result.stderr).toContain(join("src", "extension.ts"));
});

it("refuses to start without a supported Pi and says how to install one", () => {
  const missing = tesota(launcherCopy(), ["--help"], folder(), folder());
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("found no Pi beside it or on PATH");
  expect(missing.stderr).toContain(`npm install --global ${PI_PACKAGE}@latest`);
  const old = tesota(launcherCopy("1.0.0"), ["--help"], folder());
  expect(old.status).toBe(1);
  expect(old.stderr).toContain("the Pi it found is 1.0.0");
});

it("exits with Pi's exit code", () => {
  expect(tesota(launcherCopy("9.0.0"), [], folder()).status).toBe(7);
});

it("runs the Pi on PATH with Node, so no argument passes through a shell", () => {
  const prefix = folder();
  stubPi(prefix, "9.0.0");
  const script = "node_modules/@earendil-works/pi-coding-agent/cli.js";
  writeFileSync(join(prefix, "pi.cmd"), `@"%dp0%\\node.exe" "%dp0%\\${script.replaceAll("/", "\\")}" %*\r\n`);
  writeFileSync(join(prefix, "pi"), `#!/bin/sh\nexec node "$basedir/${script}" "$@"\n`);
  const cli = launcherCopy();
  const args = ["-p", `say "hi" & echo pwned | more`, "%PATH%", "$HOME", "a^b"];
  const result = tesota(cli, args, folder(), `${folder()}${delimiter}${prefix}`);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(["--extension", dirname(dirname(cli)), ...args]);
  expect(result.status).toBe(7);
});
