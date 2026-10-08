import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installedPi, minimumPiVersion, PI_PACKAGE, piProblem } from "../src/pi-install.js";
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
  expect(installedPi(join(root, "node_modules", "tesota"))).toEqual({
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

it("accepts a Pi at or above the minimum and says how to install one otherwise", () => {
  const pi = (version: string) => ({ version, cli: "cli.js" });
  for (const version of ["1.1.0", "1.1.1", "1.2.0", "2.0.0", "1.1.0-beta.1"]) expect(piProblem(pi(version), "1.1.0")).toBeUndefined();
  for (const version of ["1.0.9", "0.99.1", "unknown"]) {
    expect(piProblem(pi(version), "1.1.0")).toContain(`Tesota needs Pi 1.1.0 or later, and the Pi installed beside it is ${version}.`);
  }
  expect(piProblem(undefined, "1.1.0")).toContain(`npm install --global ${PI_PACKAGE}@latest`);
});

it("compares release numbers in order, major first", () => {
  expect(versionAtLeast(1, 1, 0, 1, 1, 0)).toBe(true);
  expect(versionAtLeast(2, 0, 0, 1, 9, 9)).toBe(true);
  expect(versionAtLeast(1, 0, 9, 1, 1, 0)).toBe(false);
  expect(versionAtLeast(1, 1, 0, 1, 1, 1)).toBe(false);
});
