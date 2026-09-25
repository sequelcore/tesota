import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const env: NodeJS.ProcessEnv = {};
for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
  const value = process.env[key];
  if (value !== undefined) env[key] = value;
}

function run(args: readonly string[]) {
  const result = spawnSync("bun", ["--no-env-file", entry, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5000,
    maxBuffer: 64 * 1024,
    env,
  });
  if (result.error !== undefined) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}

it("publishes the compiled CLI through the canonical tesota executable", () => {
  const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  expect(manifest).toMatchObject({ bin: { tesota: "dist/cli.js" } });
  expect(readFileSync(entry, "utf8")).toMatch(/^#!\/usr\/bin\/env bun\r?\n/u);
});

it.each([[], ["--help"], ["-h"], ["help"]])("prints compiled CLI help for %j", (...args) => {
  const result = run(args);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "Tesota\nUsage: tesota [--help | -h | help]\n" +
    "       tesota [--theme <tesota-dark|tesota-light|terminal>]\n" +
    "       tesota verify <file.ts|file.js>\n" +
    "       tesota auth <login|status|logout>\n\n" +
    "Starts a coding session in the current repository. The agent works in a\n" +
    "separate copy; you review its changes and checks before anything is applied.\n",
  );
});

it.each([["--unknown"], ["run"], ["--help", "--unknown"], ["help", "extra"], ["--theme"], ["--execution", "host-local"],
  ["task", "propose", "Explain"], ["candidate", "list"], ["isolation", "qualify"]])(
  "rejects invalid compiled CLI arguments %j",
  (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid arguments. Use tesota --help.\n");
  },
);
