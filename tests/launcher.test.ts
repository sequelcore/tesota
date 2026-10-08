import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const tesota = (cli: string, args: readonly string[], cwd: string) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, input: "", encoding: "utf8", timeout: 30_000 });

it("runs Pi with Tesota's extension loaded and passes the arguments through", () => {
  const result = tesota(resolve("dist/cli.js"), ["--mode", "rpc", "--no-session"], folder());
  expect(result.stderr).toBe("");
  const requests = result.stdout.split("\n").filter((line) => line.startsWith("{")).map((line): unknown => JSON.parse(line));
  expect(requests).toContainEqual(expect.objectContaining({ method: "setStatus", statusKey: "tesota", statusText: "Tesota" }));
  expect(result.status).toBe(0);
});

/** A copy of the built launcher with no Pi beside it, or with the Pi `version` names. */
function launcherCopy(version?: string): string {
  const root = folder();
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("package.json", join(root, "package.json"));
  if (version !== undefined) {
    mkdirSync(join(root, "node_modules", PI_PACKAGE), { recursive: true });
    writeFileSync(join(root, "node_modules", PI_PACKAGE, "package.json"), JSON.stringify({ version, bin: { pi: "cli.js" } }));
    writeFileSync(join(root, "node_modules", PI_PACKAGE, "cli.js"), "process.exit(7);\n");
  }
  return join(root, "dist", "cli.js");
}

it("refuses to start without a supported Pi and says how to install one", () => {
  const missing = tesota(launcherCopy(), ["--help"], folder());
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("Pi is not installed beside it");
  expect(missing.stderr).toContain(`npm install --global ${PI_PACKAGE}@latest`);
  const old = tesota(launcherCopy("1.0.0"), ["--help"], folder());
  expect(old.status).toBe(1);
  expect(old.stderr).toContain("the Pi installed beside it is 1.0.0");
});

it("exits with Pi's exit code", () => {
  expect(tesota(launcherCopy("9.0.0"), [], folder()).status).toBe(7);
});
