import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { assessApplicability, configuredOxlint, runOxlint, type OxlintCheck } from "../src/verification/oxlint.js";
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

it.each(["source.ts", "source.js"])("passes valid synthetic %s through the executor and compiled CLI", async (name) => {
  const { root, check } = await fixture();
  const file = join(root, name);
  await writeFile(file, "export const value = 1;\n");
  const result = await runOxlint(check, file);
  expect(result).toMatchObject({ status: "passed", profile: "oxlint-basic/v1", file, diagnostics: [], process: "exited" });
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
  expect((await assessApplicability(result, check)).status).toBe("applicable");
  expect(await readFile(file, "utf8")).toBe(source);
});

it("reports a missing executable as an execution failure", async () => {
  const { root, file, check } = await fixture();
  expect(await runOxlint({ ...check, executable: join(root, "missing-bun.exe") }, file))
    .toMatchObject({ status: "execution_failed", reason: "spawn_failed", process: "not_started" });
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
  expect(result).toMatchObject({ status: "execution_failed", reason: "invalid_verifier_result", process: "exited" });
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
    .toMatchObject({ status: "execution_failed", reason: "output_limit", process: "exited" });
});

it("times out a real hanging process and verifies it has exited", async () => {
  const { root, file } = await fixture();
  const pidFile = join(root, "pid");
  const check = await fakeInstallation(root,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  expect(await runOxlint({ ...check, timeoutMs: 1000 }, file))
    .toMatchObject({ status: "execution_failed", reason: "timeout", process: "exited" });
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(Number.isSafeInteger(pid)).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow();
});

it("binds exact bytes and the effective check through the compiled CLI", async () => {
  const source = Buffer.from("\ufeffexport const value = 1;\r\n");
  const { file, check } = await fixture();
  await writeFile(file, source);
  const result = await runOxlint(check, file);
  expect(result.status).toBe("passed");
  expect(result.binding?.source).toEqual({ file, sha256: createHash("sha256").update(source).digest("hex") });
  expect(result.binding?.check.configuration).toBe(check.configuration);
  expect(result.binding?.check.arguments).toContain("source.ts");
  expect(result.binding?.verifier).toMatchObject({ packageVersion: "1.82.0", executable: bun });
  expect(result.binding?.verifier.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(runCli(file)).toEqual({ code: 0, result });
  expect((await assessApplicability(result, check)).status).toBe("applicable");
  await writeFile(file, "debugger;\n");
  expect((await assessApplicability(result, check)).status).toBe("stale");
  expect(result.status).toBe("passed");
});

it("compares configuration contents even with the same profile label", async () => {
  const { file, check } = await fixture();
  const result = await runOxlint(check, file);
  expect((await assessApplicability(result, { ...check, configuration: check.configuration + " " })).status).toBe("stale");
  expect(result.binding?.check.profile).toBe("oxlint-basic/v1");
  expect((await assessApplicability(result, { ...check, timeoutMs: check.timeoutMs + 1 })).status).toBe("stale");
});

it("never makes unavailable sources or serialized assertions applicable", async () => {
  const { file, check } = await fixture();
  const result = await runOxlint(check, file);
  expect((await assessApplicability({ ...result }, check)).status).toBe("unavailable");
  expect((await assessApplicability(result, { ...check, executable: join(check.cwd, "missing.exe") })).status).toBe("unavailable");
  await rm(file);
  expect((await assessApplicability(result, check)).status).toBe("unavailable");
  await mkdir(file);
  expect((await assessApplicability(result, check)).status).toBe("unavailable");
});

it.each(["entry", "native"])("binds %s content, not just the declared package version", async (changed) => {
  const { root, file } = await fixture();
  const check = await fakeInstallation(root, 'console.log(JSON.stringify({diagnostics:[],number_of_files:1,number_of_rules:2,threads_count:1,start_time:0}));');
  const nativeRoot = join(root, "node_modules/@oxlint/binding-test");
  await mkdir(nativeRoot, { recursive: true });
  await writeFile(join(nativeRoot, "package.json"), '{"version":"1.82.0","main":"native.node"}');
  const native = join(nativeRoot, "native.node");
  await writeFile(native, "synthetic native bytes");
  await writeFile(join(root, "node_modules/oxlint/package.json"), JSON.stringify({
    version: "1.82.0", type: "module", optionalDependencies: { "@oxlint/binding-test": "1.82.0" },
  }));
  const result = await runOxlint(check, file);
  expect(result.status).toBe("passed");
  expect((await assessApplicability(result, check)).status).toBe("applicable");
  await writeFile(changed === "entry" ? check.entry : native, "// changed installation\n");
  expect((await assessApplicability(result, check)).status).toBe("stale");
});
