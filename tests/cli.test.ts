import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
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

it.each([[], ["--help"], ["-h"], ["help"]])("prints compiled CLI help for %j", (...args) => {
  const result = run(args);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "Tesota (provisional)\nUsage: tesota [--help | -h | help]\n" +
    "       tesota verify <file.ts|file.js>\n\n" +
    "Runs one fixed Oxlint check. Agent execution is not implemented.\n",
  );
});

it.each([["--unknown"], ["run"], ["--help", "--unknown"], ["help", "extra"]])(
  "rejects invalid compiled CLI arguments %j",
  (...args) => {
    const result = run(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Invalid arguments. Use tesota --help.\n");
  },
);
