import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { configuredOxlint, runOxlint, type OxlintCheck } from "../src/verification/oxlint.js";
import { interpretOxlint } from "../src/verification/oxlint-result.js";

const bun = execFileSync("bun", ["--no-env-file", "-p", "process.execPath"], {
  encoding: "utf8", windowsHide: true, timeout: 5000,
}).trim();
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source = "export const value = 1;\n") {
  const root = await mkdtemp(join(tmpdir(), "tesota-check-test-"));
  roots.push(root);
  const file = join(root, "source.ts");
  await writeFile(file, source, "utf8");
  return { root, file, check: configuredOxlint(root, bun) };
}

function runCli(file: string, entry = cli) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const run = spawnSync(bun, ["--no-env-file", entry, "verify", file], {
    encoding: "utf8", windowsHide: true, shell: false, env,
    timeout: 15_000, maxBuffer: 512 * 1024,
  });
  expect(run.error).toBeUndefined();
  expect(run.signal).toBeNull();
  expect(run.stderr).toBe("");
  const result: unknown = JSON.parse(run.stdout);
  return { code: run.status, result };
}

async function fakeInstallation(root: string, script: string): Promise<OxlintCheck> {
  const packageRoot = join(root, "node_modules/oxlint");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "1.82.0", type: "module" }));
  const entry = join(packageRoot, "bin/oxlint");
  await writeFile(entry, script, "utf8");
  return { ...configuredOxlint(root, bun), entry };
}

it("passes valid synthetic source through the executor and compiled CLI", async () => {
  const { file, check } = await fixture();
  const result = await runOxlint(check, file);
  expect(result).toEqual({ status: "passed", profile: "oxlint-basic/v1", file, diagnostics: [], process: "exited" });
  expect(runCli(file)).toEqual({ code: 0, result });
});

it.each(["debugger;\n", "const unusedValue = 1;\n"])("reports a real violation without fixing %j", async (source) => {
  const { file, check } = await fixture(source);
  const result = await runOxlint(check, file);
  expect(result).toMatchObject({ status: "check_failed", process: "exited" });
  if (result.status === "execution_failed") throw new Error("Expected lint diagnostics");
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.rule).toBe(source.startsWith("debugger") ? "eslint(no-debugger)" : "eslint(no-unused-vars)");
  expect(runCli(file)).toEqual({ code: 1, result });
  expect(await readFile(file, "utf8")).toBe(source);
});

it("reports a missing executable as an execution failure", async () => {
  const { root, file, check } = await fixture();
  expect(await runOxlint({ ...check, executable: join(root, "missing-bun.exe") }, file))
    .toEqual({ status: "execution_failed", reason: "spawn_failed", process: "not_started" });
});

it("exposes a missing verifier installation through the compiled CLI", async () => {
  const { root, file } = await fixture();
  await cp(fileURLToPath(new URL("../dist", import.meta.url)), join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  expect(runCli(file, join(root, "dist/cli.js"))).toEqual({ code: 2, result: {
    status: "execution_failed", reason: "input_or_installation_unavailable", process: "not_started",
  } });
});

it("does not accept unexpected output even with exit zero, including through the compiled CLI", async () => {
  const { root, file } = await fixture();
  const check = await fakeInstallation(root, 'console.log("looks good");');
  const result = await runOxlint(check, file);
  expect(result).toEqual({ status: "execution_failed", reason: "invalid_verifier_result", process: "exited" });
  await cp(fileURLToPath(new URL("../dist", import.meta.url)), join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  expect(runCli(file, join(root, "dist/cli.js"))).toEqual({ code: 2, result });
});

it.each([
  { output: "", code: 0 },
  { output: "{}", code: 0 },
  { output: '{"diagnostics":[]}', code: 0 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 0, number_of_rules: 2, threads_count: 1, start_time: 0 }), code: 0 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: 0, threads_count: 1, start_time: 0 }), code: 0 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: 2, threads_count: 1, start_time: 0 }), code: 1 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: 2, threads_count: 1, start_time: 0 }), code: 9 },
])("rejects incomplete or inconsistent producer evidence %#", ({ output, code }) => {
  expect(interpretOxlint(output, "", code, resolve("source.ts")))
    .toEqual({ status: "execution_failed", reason: "invalid_verifier_result", process: "exited" });
});

it("does not read candidate configuration, execute plugins, or honor inline suppressions", async () => {
  const { root, file, check } = await fixture("debugger;\n");
  await writeFile(join(root, "oxlint.config.ts"), 'throw new Error("must not execute");');
  expect(await runOxlint(check, file)).toMatchObject({ status: "check_failed" });
  await writeFile(file, "// oxlint-disable\ndebugger;\n");
  expect(await runOxlint(check, file)).toEqual({ status: "execution_failed", reason: "inline_suppression", process: "not_started" });
});

it("rejects absent, non-file and malformed source rather than approving it", async () => {
  const { root, file, check } = await fixture("const = ;\n");
  expect(await runOxlint(check, file)).toMatchObject({ status: "execution_failed" });
  expect(await runOxlint(check, root)).toMatchObject({ status: "execution_failed", reason: "unsupported_input" });
  expect(await runOxlint(check, join(root, "absent.ts"))).toMatchObject({ status: "execution_failed" });
});

it("bounds output and observes termination of an overflowing verifier", async () => {
  const { root, file } = await fixture();
  const check = await fakeInstallation(root, 'process.stdout.write("x".repeat(65536)); setInterval(() => {}, 1000);');
  expect(await runOxlint({ ...check, maxOutputBytes: 1024 }, file))
    .toEqual({ status: "execution_failed", reason: "output_limit", process: "exited" });
});

it("times out a real hanging process and verifies it has exited", async () => {
  const { root, file } = await fixture();
  const pidFile = join(root, "pid");
  const check = await fakeInstallation(root,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  expect(await runOxlint({ ...check, timeoutMs: 1000 }, file))
    .toEqual({ status: "execution_failed", reason: "timeout", process: "exited" });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});
