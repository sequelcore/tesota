import { afterAll, beforeAll, expect, test } from "bun:test";
import { doctorCommand, formatDoctorReport, probe, repairCommand, type Diagnosis } from "../src/doctor.ts";
import { tlaChecker } from "../../../src/model-check.ts";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../../src/process.ts";
import { build } from "../scripts/build.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const isolatedEnvironment = (home: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: "", HOME: home, USERPROFILE: home,
  APPDATA: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, "claude"),
  // Source startup otherwise caches transpilation before main; release binaries do not transpile.
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
import { doctorExitCode } from "../src/doctor-rule.ts";

test("doctor reports an available tool's path, version and smoke result", async () => {
  const result = await probe({ id: "runtime", requirement: "core", executable: process.execPath, args: ["--version"], consequence: "Not proved", repair: "See install" });
  expect(result.status).toBe("available");
  expect(result.path).toBe(process.execPath);
  expect(result.version).toMatch(/^\d+\.\d+/u);
  expect(result.smoke.ended).toBe("exited");
  expect(result.smoke.exitCode).toBe(0);
});

const base = { id: "fixture", requirement: "core" as const, consequence: "Not proved", repair: "See install" };

test("a missing executable is unavailable, not failed", async () => {
  const result = await probe({ ...base, executable: "tesota-doctor-missing-687", args: ["--version"] });
  expect(result.status).toBe("unavailable");
  expect(result.path).toBeNull();
  expect(result.version).toBeNull();
  expect(result.smoke.ended).toBe("not_started");
});

test("a found executable that exits unsuccessfully is failed", async () => {
  const result = await probe({ ...base, executable: process.execPath, args: ["-e", "process.exit(7)"] });
  expect(result.status).toBe("failed");
  expect(result.path).toBe(process.execPath);
  expect(result.smoke.exitCode).toBe(7);
});

test("a timed-out probe is failed and awaited", async () => {
  const result = await probe({ ...base, executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, 100);
  expect(result.status).toBe("failed");
  expect(result.smoke.ended).toBe("timed_out");
  expect(result.smoke.exitCode).toBeNull();
});

test("unsupported tool versions fail even when the command succeeds", async () => {
  const result = await probe({ ...base, executable: process.execPath, args: ["-e", "console.log('Dafny 3.0')"], accepts: /Dafny 4\./u });
  expect(result.status).toBe("failed");
  expect(result.smoke.exitCode).toBe(0);
});

test("exit codes distinguish failure from unavailable, with failures taking precedence", () => {
  expect(doctorExitCode(false, false)).toBe(0);
  expect(doctorExitCode(true, false)).toBe(1);
  expect(doctorExitCode(false, true)).toBe(2);
  expect(doctorExitCode(true, true)).toBe(1);
});

test("the shared process lookup respects a run's supplied PATH", async () => {
  const result = await runProcess("bun", ["--version"], process.cwd(), new AbortController().signal, 1_000,
    undefined, { env: { ...process.env, PATH: "" } });
  expect(result.ended).toBe("not_started");
});

test("repair commands for all operating systems come from the install guide", () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    for (const id of ["dafny", "lsc", "tla-ts", "quint", "java", "git", "claude-code", "provider"]) {
      expect(repairCommand(id, platform).length).toBeGreaterThan(0);
    }
  }
  expect(repairCommand("git", "win32")).toBe("winget install Git.Git");
  expect(repairCommand("git", "darwin")).toBe("brew install git");
  expect(repairCommand("git", "linux")).toBe("sudo apt-get install git");
});

test("human and JSON renderings retain the same report", () => {
  const report = { exitCode: 0, warnings: ["Settings Tesota does not know, in /home/settings.json, did nothing: tlcPath."], capabilities: [{ id: "quint", requirement: "optional" as const, status: "unavailable", path: null, version: null,
    smoke: { ended: "not_started" as const, exitCode: null, output: "Executable not found." },
    consequence: "Model not checked: Quint models cannot be checked.", repair: "npm install -g @informalsystems/quint" }] };
  expect(JSON.parse(formatDoctorReport(report, true))).toEqual(report);
  const human = formatDoctorReport(report, false);
  expect(human).toContain("quint: unavailable (optional)");
  expect(human).toContain("Version: unknown");
  expect(human).toContain("not_started, exit none: Executable not found.");
  expect(human).toContain("Model not checked: Quint models cannot be checked.");
  expect(human).toContain("npm install -g @informalsystems/quint");
  expect(human).toContain("Exit code: 0");
  expect(human).toContain("Warning: Settings Tesota does not know, in /home/settings.json, did nothing: tlcPath.");
});

test("help and invalid arguments do not run any probe", async () => {
  const out: string[] = [], error: string[] = [];
  const output = { out: (text: string) => { out.push(text); }, error: (text: string) => { error.push(text); } };
  expect(await doctorCommand(["--help"], output)).toBe(0);
  expect(out.join("")).toContain("tesota doctor [--json]");
  expect(out.join("")).toContain("model provider (at least one provider row available)");
  expect(out.join("")).toContain("Optional: Quint and individual provider rows");
  expect(out.join("")).toContain("Unavailable optional tools do not affect the exit code");
  expect(await doctorCommand(["--install"], output)).toBe(3);
  expect(error.join("")).toContain("Read-only");
});

test("the CLI reports missing tools as JSON without writing to a fresh home or project", async () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-"));
  try {
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: isolatedEnvironment(home) });
    expect(result.ended).toBe("exited");
    const report = JSON.parse(result.stdout) as { exitCode: number; capabilities: Diagnosis[] };
    expect(result.exitCode).toBe(report.exitCode);
    expect(report.capabilities.find(({ id }) => id === "dafny")?.status).toBe("unavailable");
    expect(report.capabilities.find(({ id }) => id === "git")?.path).toBeNull();
    expect(report.capabilities.find(({ id }) => id === "tla-ts")).toMatchObject({ status: "available", version: tlaChecker });
    expect(report.capabilities.find(({ id }) => id === "lsc")?.status).toBe("available");
    expect(report.capabilities.find(({ id }) => id === "claude-code")).toBeDefined();
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the CLI warns about a settings key Tesota does not read, and leaves the file as written (#714)", async () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-unknown-"));
  try {
    const settingsPath = join(home, ".tesota", "settings.json");
    mkdirSync(join(home, ".tesota"));
    const written = JSON.stringify({ tlcPath: "/tools/tla2tools.jar", tuiMode: "inline" });
    writeFileSync(settingsPath, written);
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: isolatedEnvironment(home) });
    const report = JSON.parse(result.stdout) as { warnings: string[] };
    expect(report.warnings).toEqual([`Settings Tesota does not know, in ${settingsPath}, did nothing: tlcPath. `
      + "See https://github.com/sequelcore/tesota/blob/main/docs/reference/configuration.md#settingsjson"]);
    expect(readFileSync(settingsPath, "utf8")).toBe(written);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a CLAUDE_CODE_EXECUTABLE that does not exist is named in the repair, not reported as a missing install (#680)", async () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-stale-claude-"));
  try {
    const stale = join(home, "gone", "claude");
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { ...isolatedEnvironment(home), CLAUDE_CODE_EXECUTABLE: stale } });
    expect(result.ended).toBe("exited");
    const report = JSON.parse(result.stdout) as { capabilities: Diagnosis[] };
    const claude = report.capabilities.find(({ id }) => id === "claude-code");
    expect(claude?.status).toBe("unavailable");
    expect(claude?.repair).toContain(`CLAUDE_CODE_EXECUTABLE is set to ${stale}, which does not exist`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the default and declared Claude accounts are version-only, without touching their files", async () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-accounts-"));
  try {
    mkdirSync(join(home, ".tesota"));
    const folder = join(home, "private-claude");
    const settings = JSON.stringify({ accounts: [{ provider: "claude-code", name: "work", folder }] });
    const path = join(home, ".tesota", "settings.json");
    writeFileSync(path, settings);
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: isolatedEnvironment(home) });
    expect(result.ended).toBe("exited");
    const report = JSON.parse(result.stdout) as { capabilities: Diagnosis[] };
    const defaults = report.capabilities.find(({ id }) => id === "claude-code");
    const named = report.capabilities.find(({ id }) => id === "claude-code@work");
    expect(defaults).toBeDefined();
    expect(named).toBeDefined();
    expect(defaults?.smoke.output).toContain("Sign-in not checked (version-only probe).");
    expect(named?.smoke.output).toContain("Sign-in not checked (version-only probe).");
    expect(named?.path).toBe(defaults?.path);
    expect(named?.status).toBe(defaults?.status);
    expect(defaults?.requirement).toBe("optional");
    expect(named?.requirement).toBe("optional");
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(home)).toEqual([".tesota"]);
    expect(readdirSync(join(home, ".tesota"))).toEqual(["settings.json"]);
    expect(readFileSync(path, "utf8")).toBe(settings);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("doctor excludes non-chat providers even with an ambient API key", async () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-chat-"));
  try {
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { ...isolatedEnvironment(home), TYPESAFE_API_KEY: "fake-classifier-key", OPENAI_API_KEY: "fake-chat-key" } });
    expect(result.ended).toBe("exited");
    const report = JSON.parse(result.stdout) as { capabilities: Diagnosis[] };
    expect(report.capabilities.find(({ id }) => id === "provider:typesafe")).toBeUndefined();
    expect(report.capabilities.find(({ id }) => id === "provider:openai")?.status).toBe("available");
    expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

let toolFixture = "";
let toolRoot = "";
let doctorBinary = "";
beforeAll(() => {
  toolRoot = mkdtempSync(join(tmpdir(), "tesota-doctor-tools-"));
  const source = join(toolRoot, "tool.ts");
  toolFixture = join(toolRoot, process.platform === "win32" ? "tool.exe" : "tool");
  writeFileSync(source, `import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const name = basename(process.execPath).replace(/\\.exe$/u, "");
if (process.env["TOOL_LOG"]) appendFileSync(process.env["TOOL_LOG"], name + " " + process.argv.slice(2).join(" ") + "\\n");
if (name === "quint" && !process.env["QUINT_OK"]) process.exit(7);
if (name === "java") { console.error('openjdk version "' + (process.env["JAVA_VERSION"] ?? "21.0.1") + '" 2026-01-01'); process.exit(0); }
console.log(name === "dafny" ? "4.11.0" : name + " version 1.0.0");
`);
  const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", toolFixture], { stdout: "ignore", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  doctorBinary = join(toolRoot, process.platform === "win32" ? "tesota.exe" : "tesota");
  build(doctorBinary);
});
// The folder holds executables this file compiled; Windows can hold them briefly after they exit, and CI failed
// with EBUSY here. Wait up to about ten seconds, as the isolated run's other cleanups do.
afterAll(() => { if (toolRoot) rmSync(toolRoot, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); });

test.each([
  { scenario: "only Quint and Java missing gives 0", tools: ["git", "dafny", "claude"], unavailable: ["quint", "java"],
    exit: 0, git: "available", quint: "unavailable" },
  { scenario: "missing core Git gives 2", tools: ["dafny", "claude"], unavailable: ["git", "quint", "java"],
    exit: 2, git: "unavailable", quint: "unavailable" },
  { scenario: "failed optional Quint gives 1", tools: ["git", "dafny", "claude", "quint", "java"], unavailable: [],
    exit: 1, git: "available", quint: "failed" },
])("core/optional policy: $scenario", async ({ tools, unavailable, exit, git, quint }) => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-optional-"));
  try {
    for (const name of tools) {
      linkSync(toolFixture, join(home, process.platform === "win32" ? `${name}.exe` : name));
    }
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { ...isolatedEnvironment(home), PATH: home } });
    const report = JSON.parse(result.stdout) as { exitCode: number; capabilities: Diagnosis[] };
    expect(report.capabilities.filter(({ status }) => status === "unavailable").map(({ id }) => id)).toEqual([...unavailable]);
    expect(report.exitCode).toBe(exit);
    expect(result.exitCode).toBe(exit);
    expect(report.capabilities.find(({ id }) => id === "quint")).toMatchObject({ requirement: "optional", status: quint });
    expect(report.capabilities.find(({ id }) => id === "git")).toMatchObject({ requirement: "core", status: git });
    for (const id of ["dafny", "lsc", "tla-ts"]) {
      expect(report.capabilities.find((item) => item.id === id)).toMatchObject({ requirement: "core", status: "available" });
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.each([
  { java: "21.0.1", status: "available", exit: 0 },
  { java: "25", status: "available", exit: 0 },
  { java: "17.0.9", status: "unavailable", exit: 0 },
  { java: "1.8.0_402", status: "unavailable", exit: 0 },
])("on every platform doctor starts Quint and Java without running a model check: Java $java is $status", async ({ java, status, exit }) => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-quint-"));
  const log = join(home, "tool.log");
  try {
    for (const name of ["git", "dafny", "claude", "quint", "java"]) linkSync(toolFixture, join(home, process.platform === "win32" ? `${name}.exe` : name));
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { ...isolatedEnvironment(home), PATH: home, TOOL_LOG: log, QUINT_OK: "1", JAVA_VERSION: java } });
    const report = JSON.parse(result.stdout) as { exitCode: number; capabilities: Diagnosis[] };
    expect(report.capabilities.find(({ id }) => id === "quint")).toMatchObject({ status: "available" });
    expect(report.capabilities.find(({ id }) => id === "java")).toMatchObject({ requirement: "optional", status });
    expect(report.exitCode).toBe(exit);
    expect(readFileSync(log, "utf8").split("\n").filter((line) => /^(quint|java) /u.test(line)).sort())
      .toEqual(["java -version", "quint --version"]);
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 }); }
});

test.each([
  { scenario: "OpenRouter only without Claude Code gives 0", key: "fake-openrouter-key", exit: 0, status: "available", failed: false },
  { scenario: "no provider at all gives 2", key: "", exit: 2, status: "unavailable", failed: false },
  { scenario: "failed optional provider still gives 1 with OpenRouter available", key: "fake-openrouter-key", exit: 1, status: "available", failed: true },
])("model provider capability: $scenario", async ({ key, exit, status, failed }) => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-provider-"));
  try {
    for (const name of ["git", "dafny"]) {
      linkSync(toolFixture, join(home, process.platform === "win32" ? `${name}.exe` : name));
    }
    if (failed) {
      mkdirSync(join(home, ".tesota"));
      writeFileSync(join(home, ".tesota", "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-ant-oat-fake-plan-token" } }));
    }
    const result = await runProcess(doctorBinary, ["doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { PATH: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        SystemRoot: process.env["SystemRoot"], TMPDIR: home, TEMP: home, TMP: home, OPENROUTER_API_KEY: key } });
    expect(result.ended).toBe("exited");
    const report = JSON.parse(result.stdout) as { exitCode: number; capabilities: Diagnosis[] };
    expect(result.exitCode).toBe(exit);
    expect(report.exitCode).toBe(exit);
    expect(report.capabilities.find(({ id }) => id === "claude-code")).toMatchObject({ requirement: "optional", status: "unavailable" });
    const summary = report.capabilities.find(({ id }) => id === "model provider");
    expect(summary).toMatchObject({ requirement: "core", status });
    expect(summary?.repair).toContain("/login");
    expect(summary?.repair).toContain("docs/guides/models.md");
    if (failed) {
      expect(report.capabilities.find(({ id }) => id === "provider:anthropic")).toMatchObject({ requirement: "optional", status: "failed" });
    }
    if (key) {
      expect(report.capabilities.find(({ id }) => id === "provider:openrouter")).toMatchObject({ requirement: "optional", status: "available" });
    } else {
      expect(report.capabilities.some(({ id, status }) => (id.startsWith("provider:") || id.startsWith("claude-code")) && status === "available")).toBe(false);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
