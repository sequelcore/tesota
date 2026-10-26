import { expect, test } from "bun:test";
import { doctorCommand, formatDoctorReport, probe, repairCommand, type Diagnosis } from "../src/doctor.ts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../../../src/process.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const isolatedEnvironment = (home: string): NodeJS.ProcessEnv => ({ ...process.env, PATH: "", HOME: home, USERPROFILE: home,
  APPDATA: home, LOCALAPPDATA: home, CLAUDE_CONFIG_DIR: join(home, "claude"),
  // Source startup otherwise caches transpilation before main; release binaries do not transpile.
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" });
import { doctorExitCode } from "../src/doctor-rule.ts";

test("doctor reports an available tool's path, version and smoke result", async () => {
  const result = await probe({ id: "runtime", executable: process.execPath, args: ["--version"], consequence: "Not proved", repair: "See install" });
  expect(result.status).toBe("available");
  expect(result.path).toBe(process.execPath);
  expect(result.version).toMatch(/^\d+\.\d+/u);
  expect(result.smoke.ended).toBe("exited");
  expect(result.smoke.exitCode).toBe(0);
});

const base = { id: "fixture", consequence: "Not proved", repair: "See install" };

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
  const report = { exitCode: 2, capabilities: [{ id: "quint", status: "unavailable", path: null, version: null,
    smoke: { ended: "not_started" as const, exitCode: null, output: "Executable not found." },
    consequence: "Model not checked: Quint models cannot be checked.", repair: "npm install -g @informalsystems/quint" }] };
  expect(JSON.parse(formatDoctorReport(report, true))).toEqual(report);
  const human = formatDoctorReport(report, false);
  expect(human).toContain("quint: unavailable");
  expect(human).toContain("Version: unknown");
  expect(human).toContain("not_started, exit none: Executable not found.");
  expect(human).toContain("Model not checked: Quint models cannot be checked.");
  expect(human).toContain("npm install -g @informalsystems/quint");
  expect(human).toContain("Exit code: 2");
});

test("help and invalid arguments do not run any probe", async () => {
  const out: string[] = [], error: string[] = [];
  const output = { out: (text: string) => { out.push(text); }, error: (text: string) => { error.push(text); } };
  expect(await doctorCommand(["--help"], output)).toBe(0);
  expect(out.join("")).toContain("tesota doctor [--json]");
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
    expect(existsSync(folder)).toBe(false);
    expect(readdirSync(home)).toEqual([".tesota"]);
    expect(readdirSync(join(home, ".tesota"))).toEqual(["settings.json"]);
    expect(readFileSync(path, "utf8")).toBe(settings);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
