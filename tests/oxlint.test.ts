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
const profile = "oxlint-static/v3";
const ruleCount = 9;
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
  expect(result).toMatchObject({ status: "passed", profile, file, diagnostics: [], process: "exited" });
  expect(runCli(file)).toEqual({ code: 0, result });
});

it.each([
  { source: "debugger;\n", rule: "eslint(no-debugger)" },
  { source: "const unusedValue = 1;\n", rule: "eslint(no-unused-vars)" },
  { source: "export const value = true || sideEffect();\nfunction sideEffect(): boolean { return false; }\n", rule: "eslint(no-constant-binary-expression)" },
  { source: "export const value = ({ callback: undefined }?.callback)();\n", rule: "eslint(no-unsafe-optional-chaining)" },
  { source: "export function fail(): void { new Error(\"denied\"); }\n", rule: "oxc(missing-throw)" },
  { source: "export function identity(value: any): unknown { return value; }\n", rule: "typescript(no-explicit-any)" },
  { source: "// @ts-ignore\nexport const value: number = \"wrong\";\n", rule: "typescript(ban-ts-comment)" },
  { source: "export function length(value?: string): number { return value!.length; }\n", rule: "typescript(no-non-null-assertion)" },
  { source: "export const values = [1, 2].reduce((all, value) => [...all, value], [] as number[]);\n", rule: "oxc(no-accumulating-spread)" },
])("reports $rule without fixing its defect", async ({ source, rule }) => {
  const { file, check } = await fixture(source);
  const result = await runOxlint(check, file);
  expect(result).toMatchObject({ status: "check_failed", process: "exited" });
  if (result.status === "execution_failed") throw new Error("Expected lint diagnostics");
  expect(result.diagnostics).toHaveLength(1);
  expect(result.diagnostics[0]?.rule).toBe(rule);
  expect(runCli(file)).toEqual({ code: 1, result });
  expect((await assessApplicability(result, check)).status).toBe("applicable");
  expect(await readFile(file, "utf8")).toBe(source);
});

it("does not flag the corresponding valid constructs", async () => {
  const source = "export function checked(value?: { callback?: () => number }): number | undefined {\n" +
    "  if (value === undefined) throw new Error(\"missing\");\n" +
    "  return value?.callback?.();\n" +
    "}\n" +
    "// @ts-expect-error -- intentional compile-time fixture\n" +
    "export const invalidAssignment: number = \"fixture\";\n" +
    "export function length(value?: string): number { if (value === undefined) return 0; return value.length; }\n" +
    "export function collect(values: readonly number[]): number[] { return values.reduce((all, value) => { all.push(value); return all; }, []); }\n";
  const { file, check } = await fixture(source);
  expect(await runOxlint(check, file)).toMatchObject({ status: "passed", profile, diagnostics: [] });
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
  { output: JSON.stringify({ diagnostics: [], number_of_files: 0, number_of_rules: ruleCount, threads_count: 1, start_time: 0 }), code: 0 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: 0, threads_count: 1, start_time: 0 }), code: 0 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: ruleCount, threads_count: 1, start_time: 0 }), code: 1 },
  { output: JSON.stringify({ diagnostics: [], number_of_files: 1, number_of_rules: ruleCount, threads_count: 1, start_time: 0 }), code: 9 },
])("rejects incomplete or inconsistent producer evidence %#", ({ output, code }) => {
  expect(interpretOxlint(output, "", code, resolve("source.ts")))
    .toEqual({ status: "execution_failed", reason: "invalid_verifier_result", process: "exited" });
});

it("projects a recognized diagnostic and rejects changes to any admitted diagnostic field", () => {
  const file = resolve("source.ts");
  const diagnostic = {
    code: "eslint(no-debugger)", severity: "error", message: "Unexpected debugger statement.",
    filename: file, labels: [{ span: { line: 3, column: 5 } }],
  };
  const report = (value: unknown) => JSON.stringify({
    diagnostics: [value], number_of_files: 1, number_of_rules: ruleCount, threads_count: 1, start_time: 0,
  });
  expect(interpretOxlint(report(diagnostic), "", 1, file)).toEqual({
    status: "check_failed", profile, file, process: "exited",
    diagnostics: [{ rule: diagnostic.code, message: diagnostic.message, line: 3, column: 5 }],
  });
  for (const invalid of [
    { ...diagnostic, code: "eslint(unadmitted)" },
    { ...diagnostic, severity: "warning" },
    { ...diagnostic, message: "" },
    { ...diagnostic, filename: resolve("other.ts") },
    { ...diagnostic, labels: [] },
    { ...diagnostic, labels: [{ span: { line: 0, column: 5 } }] },
    { ...diagnostic, labels: [{ span: { line: 3, column: 0 } }] },
  ]) {
    expect(interpretOxlint(report(invalid), "", 1, file)).toMatchObject({
      status: "execution_failed", reason: "invalid_verifier_result",
    });
  }
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
  expect(result.binding?.check.profile).toBe(profile);
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
  const check = await fakeInstallation(root, `console.log(JSON.stringify({diagnostics:[],number_of_files:1,number_of_rules:${ruleCount},threads_count:1,start_time:0}));`);
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
