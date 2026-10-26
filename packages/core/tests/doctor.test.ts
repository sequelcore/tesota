import { afterAll, beforeAll, expect, test } from "bun:test";
import { doctorCommand, formatDoctorReport, probe, repairCommand, type Diagnosis } from "../src/doctor.ts";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    for (const id of ["dafny", "lsc", "java", "tlc", "quint", "git", "claude-code", "provider"]) {
      expect(repairCommand(id, platform).length).toBeGreaterThan(0);
    }
  }
  expect(repairCommand("git", "win32")).toBe("winget install Git.Git");
  expect(repairCommand("git", "darwin")).toBe("brew install git");
  expect(repairCommand("git", "linux")).toBe("sudo apt-get install git");
});

test("human and JSON renderings retain the same report", () => {
  const report = { exitCode: 0, capabilities: [{ id: "quint", requirement: "optional" as const, status: "unavailable", path: null, version: null,
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
    expect(report.capabilities.find(({ id }) => id === "tlc")?.smoke.output).toBe("TLC jar not found.");
    expect(report.capabilities.find(({ id }) => id === "lsc")?.status).toBe("available");
    expect(report.capabilities.find(({ id }) => id === "claude-code")).toBeDefined();
    expect(readdirSync(home)).toEqual([]);
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

test.skipIf(process.platform !== "win32")("working Quint on Windows is unavailable, not failed", async () => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-quint-"));
  try {
    // A real version-printing executable at the tool boundary; no Quint installation or download.
    copyFileSync(process.execPath, join(home, "quint.exe"));
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { ...isolatedEnvironment(home), PATH: home } });
    expect(result.ended).toBe("exited");
    const report = JSON.parse(result.stdout) as { exitCode: number; capabilities: Diagnosis[] };
    const quint = report.capabilities.find(({ id }) => id === "quint");
    expect(quint?.status).toBe("unavailable");
    expect(quint?.path).toBe(join(home, "quint.exe"));
    expect(quint?.version).toMatch(/^\d+\.\d+/u);
    expect(quint?.smoke.ended).toBe("exited");
    expect(quint?.smoke.exitCode).toBe(0);
    expect(quint?.smoke.output).toContain("TLC backend cannot start Apalache on Windows");
    expect(report.exitCode).toBe(2);
    expect(result.exitCode).toBe(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

let toolFixture = "";
let toolRoot = "";
let doctorBinary = "";
beforeAll(() => {
  toolRoot = mkdtempSync(join(tmpdir(), "tesota-doctor-tools-"));
  const source = join(toolRoot, "tool.ts");
  toolFixture = join(toolRoot, process.platform === "win32" ? "tool.exe" : "tool");
  writeFileSync(source, `import { basename } from "node:path";
const name = basename(process.execPath).replace(/\\.exe$/u, "");
if (name === "quint") process.exit(7);
if (name === "java" && process.argv.includes("-help")) {
  console.log("TLC - provides model checking - Version 2.19");
  process.exit(1);
}
console.log(name === "dafny" ? "4.11.0" : name === "java" ? 'openjdk version "21.0.1"' : name + " version 1.0.0");
`);
  const built = Bun.spawnSync([process.execPath, "build", "--compile", source, "--outfile", toolFixture], { stdout: "ignore", stderr: "pipe" });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  doctorBinary = join(toolRoot, process.platform === "win32" ? "tesota.exe" : "tesota");
  build(doctorBinary);
});
afterAll(() => { if (toolRoot) rmSync(toolRoot, { recursive: true, force: true, maxRetries: 3 }); });

test.each([
  { scenario: "only Quint missing gives 0", tools: ["git", "dafny", "java", "claude"], unavailable: ["quint"],
    exit: 0, git: "available", quint: "unavailable" },
  { scenario: "missing core Git gives 2", tools: ["dafny", "java", "claude"], unavailable: ["git", "quint"],
    exit: 2, git: "unavailable", quint: "unavailable" },
  { scenario: "failed optional Quint gives 1", tools: ["git", "dafny", "java", "claude", "quint"], unavailable: [],
    exit: 1, git: "available", quint: "failed" },
])("core/optional policy: $scenario", async ({ tools, unavailable, exit, git, quint }) => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-optional-"));
  try {
    for (const name of tools) {
      linkSync(toolFixture, join(home, process.platform === "win32" ? `${name}.exe` : name));
    }
    mkdirSync(join(home, ".tesota", "tools"), { recursive: true });
    writeFileSync(join(home, ".tesota", "tools", "tla2tools.jar"), "local tool-boundary fixture");
    const result = await runProcess(process.execPath, [main, "doctor", "--json"], home, new AbortController().signal, 25_000,
      undefined, { env: { ...isolatedEnvironment(home), PATH: home } });
    const report = JSON.parse(result.stdout) as { exitCode: number; capabilities: Diagnosis[] };
    expect(report.capabilities.filter(({ status }) => status === "unavailable").map(({ id }) => id)).toEqual([...unavailable]);
    expect(report.exitCode).toBe(exit);
    expect(result.exitCode).toBe(exit);
    expect(report.capabilities.find(({ id }) => id === "quint")).toMatchObject({ requirement: "optional", status: quint });
    expect(report.capabilities.find(({ id }) => id === "git")).toMatchObject({ requirement: "core", status: git });
    for (const id of ["dafny", "lsc", "java", "tlc"]) {
      expect(report.capabilities.find((item) => item.id === id)).toMatchObject({ requirement: "core", status: "available" });
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test.each([
  { scenario: "OpenRouter only without Claude Code gives 0", key: "fake-openrouter-key", exit: 0, status: "available", failed: false },
  { scenario: "no provider at all gives 2", key: "", exit: 2, status: "unavailable", failed: false },
  { scenario: "failed optional provider still gives 1 with OpenRouter available", key: "fake-openrouter-key", exit: 1, status: "available", failed: true },
])("model provider capability: $scenario", async ({ key, exit, status, failed }) => {
  const home = mkdtempSync(join(tmpdir(), "tesota-doctor-provider-"));
  try {
    for (const name of ["git", "dafny", "java"]) {
      linkSync(toolFixture, join(home, process.platform === "win32" ? `${name}.exe` : name));
    }
    mkdirSync(join(home, ".tesota", "tools"), { recursive: true });
    writeFileSync(join(home, ".tesota", "tools", "tla2tools.jar"), "local tool-boundary fixture");
    if (failed) {
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
