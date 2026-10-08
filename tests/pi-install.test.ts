import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installedPi, minimumPiVersion, missingExtensions, PI_PACKAGE, piOnPath, piProblem } from "../src/pi-install.js";
import { versionAtLeast } from "../src/verification/pi-version-rule.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), "tesota-pi-"));
  roots.push(root);
  return root;
}

function installPi(root: string, manifest: object): void {
  mkdirSync(join(root, "node_modules", PI_PACKAGE), { recursive: true });
  writeFileSync(join(root, "node_modules", PI_PACKAGE, "package.json"), JSON.stringify(manifest));
}

it("finds Pi in the nearest node_modules folder up from Tesota, as Node resolves a package", () => {
  const root = folder();
  installPi(root, { version: "1.2.0", bin: { pi: "dist/bundle/cli.js" } });
  mkdirSync(join(root, "node_modules", "tesota", "dist"), { recursive: true });
  expect(installedPi(join(root, "node_modules", "tesota"))).toEqual({ root: join(root, "node_modules", PI_PACKAGE),
    version: "1.2.0", cli: join(root, "node_modules", PI_PACKAGE, "dist", "bundle", "cli.js") });
});

it("finds no Pi when none is installed or its manifest names no pi program", () => {
  expect(installedPi(folder())).toBeUndefined();
  const root = folder();
  installPi(root, { version: "1.2.0" });
  expect(installedPi(root)).toBeUndefined();
});

it("reads the minimum Pi from Tesota's peer range, which the development copy of Pi meets", () => {
  const minimum = minimumPiVersion(process.cwd());
  expect(minimum).toMatch(/^\d+\.\d+\.\d+$/u);
  const pi = installedPi(process.cwd());
  expect(pi?.version).toBe(JSON.parse(readFileSync("package.json", "utf8")).devDependencies[PI_PACKAGE]);
  expect(piProblem(pi, minimum)).toBeUndefined();
});

it("names the extension files the pi manifest lists that are missing, and finds none missing here", () => {
  expect(missingExtensions(process.cwd())).toEqual([]);
  const root = folder();
  writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./src/extension.ts"] } }));
  expect(missingExtensions(root)).toEqual([join(root, "src", "extension.ts")]);
  writeFileSync(join(root, "package.json"), JSON.stringify({}));
  expect(() => missingExtensions(root)).toThrow("pi.extensions");
});

it("accepts a Pi at or above the minimum and says how to install one otherwise", () => {
  const pi = (version: string) => ({ root: ".", version, cli: "cli.js" });
  for (const version of ["1.1.0", "1.1.1", "1.2.0", "2.0.0", "1.1.0-beta.1"]) expect(piProblem(pi(version), "1.1.0")).toBeUndefined();
  for (const version of ["1.0.9", "0.99.1", "unknown"]) {
    expect(piProblem(pi(version), "1.1.0")).toContain(`Tesota needs Pi 1.1.0 or later, and the Pi it found is ${version}.`);
  }
  expect(piProblem(undefined, "1.1.0")).toContain("found no Pi beside it or on PATH");
  expect(piProblem(undefined, "1.1.0")).toContain(`npm install --global ${PI_PACKAGE}@latest`);
});

it("compares release numbers in order, major first", () => {
  expect(versionAtLeast(1, 1, 0, 1, 1, 0)).toBe(true);
  expect(versionAtLeast(2, 0, 0, 1, 9, 9)).toBe(true);
  expect(versionAtLeast(1, 0, 9, 1, 1, 0)).toBe(false);
  expect(versionAtLeast(1, 1, 0, 1, 1, 1)).toBe(false);
});

/** A global install of `name` under `prefix`, as npm lays it out; returns the program its `pi` command runs. */
function globalPi(prefix: string, name = PI_PACKAGE): string {
  const root = join(prefix, "node_modules", ...name.split("/"));
  mkdirSync(join(root, "dist", "bundle"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.3.0", bin: { pi: "dist/bundle/cli.js" } }));
  writeFileSync(join(root, "dist", "bundle", "cli.js"), "");
  return join(root, "dist", "bundle", "cli.js");
}

// The last lines of the shims npm (cmd-shim) and pnpm write on Windows.
const npmShim = String.raw`IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
)
endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" %*
`;
const pnpmShim = String.raw`@IF EXIST "%~dp0\node.exe" (
  "%~dp0\node.exe"  "%~dp0\..\global\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" %*
)
`;

it("runs the script npm's and pnpm's Windows shims name, never the shim", () => {
  const npm = folder();
  const cli = globalPi(npm);
  writeFileSync(join(npm, "pi.cmd"), npmShim);
  expect(piOnPath(`${folder()};${npm}`, "win32")).toEqual({ root: join(cli, "..", "..", ".."), version: "1.3.0", cli });
  const pnpm = folder();
  const pnpmCli = globalPi(join(pnpm, "global"));
  mkdirSync(join(pnpm, "bin"));
  writeFileSync(join(pnpm, "bin", "pi.cmd"), pnpmShim);
  expect(piOnPath(join(pnpm, "bin"), "win32")).toEqual({ root: join(pnpmCli, "..", "..", ".."), version: "1.3.0", cli: pnpmCli });
});

// A Linux or macOS PATH: a Windows folder's drive letter would split at its colon.
it.skipIf(process.platform === "win32")("runs the script a shell shim names or npm links pi to, and no binary pi", () => {
  const prefix = folder();
  const cli = globalPi(prefix);
  writeFileSync(join(prefix, "pi"), '#!/bin/sh\nexec node  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" "$@"\n');
  expect(piOnPath(prefix, "linux")).toEqual({ root: join(cli, "..", "..", ".."), version: "1.3.0", cli });
  const linked = folder();
  symlinkSync(cli, join(linked, "pi"));
  expect(piOnPath(linked, "linux")).toEqual({ root: join(cli, "..", "..", ".."), version: "1.3.0", cli });
  const binary = folder();
  writeFileSync(join(binary, "pi"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
  expect(piOnPath(`${binary}:${prefix}`, "linux")).toBeUndefined();
});

it("uses only the first pi on PATH, and only when it runs an installed Pi package", () => {
  const other = folder();
  globalPi(other, "@example/not-pi");
  writeFileSync(join(other, "pi.cmd"), npmShim.replace(String.raw`@earendil-works\pi-coding-agent`, String.raw`@example\not-pi`));
  const real = folder();
  globalPi(real);
  writeFileSync(join(real, "pi.cmd"), npmShim);
  expect(piOnPath(`${other};${real}`, "win32")).toBeUndefined();
  const missing = folder();
  writeFileSync(join(missing, "pi.cmd"), npmShim);
  expect(piOnPath(missing, "win32")).toBeUndefined();
  expect(piOnPath("", "win32")).toBeUndefined();
});
