import { processExecutable, runProcess, type ProcessRun } from "../../../src/process.ts";
import { doctorExitCode, doctorStatus } from "./doctor-rule.ts";
import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { tlaToolsJar } from "../../../src/model-check.ts";
import { lscCommand } from "../../../src/verification/lemmascript-verifier.ts";
import { fileCredentialStore } from "./credentials.ts";
import { engineModels } from "./model-access.ts";
import { readSettings } from "./settings.ts";
import { claudeCodeExecutable } from "./providers/claude-code.ts";
import install from "../../../docs/get-started/install.md" with { type: "text" };

/** A read-only, local version/help command, never a project check or a model request. */
export interface Probe {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly consequence: string;
  readonly repair: string;
  readonly accepts?: RegExp;
  readonly successExitCode?: number;
}

export interface Diagnosis {
  readonly id: string;
  readonly status: string;
  readonly path: string | null;
  readonly version: string | null;
  readonly entryPoint?: string;
  readonly smoke: Pick<ProcessRun, "ended" | "exitCode" | "output">;
  readonly consequence: string;
  readonly repair: string;
}

/** Probe the same executable runProcess uses, within five seconds, without a shell. */
export async function probe(spec: Probe, timeoutMs = 5_000): Promise<Diagnosis> {
  const path = processExecutable(spec.executable);
  const smoke = path === undefined
    ? { ended: "not_started" as const, exitCode: null, output: "Executable not found." }
    : await runProcess(path, spec.args, process.cwd(), new AbortController().signal, timeoutMs, undefined,
      { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const output = stripVTControlCharacters(smoke.output).trim();
  const version = output.split(/\r?\n/u).find((line) => /\d+\.\d+/u.test(line))?.trim() ?? null;
  return { id: spec.id, status: doctorStatus(path !== undefined,
    smoke.ended === "exited" && smoke.exitCode === (spec.successExitCode ?? 0) && (spec.accepts?.test(output) ?? true)),
  path: path ?? null, version, smoke: { ended: smoke.ended, exitCode: smoke.exitCode, output: output.slice(0, 512) },
  consequence: spec.consequence, repair: spec.repair };
}

/** Repair commands are owned by install.md, not a second platform-specific list. */
export function repairCommand(id: string, platform: NodeJS.Platform = process.platform): string {
  const table = install.split("<!-- doctor-repairs-start -->")[1]?.split("<!-- doctor-repairs-end -->")[0] ?? "";
  const row = table.split("\n").find((line) => line.startsWith(`| ${id} |`));
  const column = platform === "win32" ? 2 : platform === "darwin" ? 3 : 4;
  const command = row?.split("|")[column]?.trim().replace(/^`|`$/gu, "");
  if (!command) throw new Error(`No ${platform} repair command for ${id} in install.md`);
  return command;
}

const proofLoss = "Not proved: LemmaScript contracts cannot be proved.";
const modelLoss = "Model not checked: design models cannot be model-checked.";
const providerLoss = "Not verified: no run with this provider until its sign-in works; other providers are unaffected.";

async function claudeDiagnosis(id: string): Promise<Diagnosis> {
  const executable = claudeCodeExecutable();
  const repair = `${repairCommand("claude-code")}; then ${id === "claude-code" ? "claude (then /login)" : `tesota accounts login ${id}`}`;
  const version = await probe({ id, executable: executable ?? "claude", args: ["--version"],
    consequence: "Not verified: no run with Claude Code when its executable is unavailable; other providers are unaffected.", repair });
  // `auth status` writes .claude.json and backups. Never invoke it or read Claude's files from doctor.
  return { ...version, smoke: { ...version.smoke, output: `${version.smoke.output}\nSign-in not checked (version-only probe).` } };
}

/** Collect sequential local probes. Project tests are deliberately not run: they may write or download. */
export async function doctorReport(): Promise<{ capabilities: Diagnosis[]; exitCode: number }> {
  const capabilities: Diagnosis[] = [];
  for (const spec of [
    { id: "dafny", executable: "dafny", args: ["--version"], consequence: proofLoss, accepts: /(?:^|\s)4\./u },
    { id: "java", executable: "java", args: ["-version"], consequence: modelLoss,
      accepts: /version "(?:1[1-9]|[2-9]\d|\d{3,})[."]/u },
    { id: "git", executable: "git", args: ["--version"], consequence: "Not verified: changes cannot be measured against a Git base or snapshot." },
    { id: "quint", executable: "quint", args: ["--version"], consequence: "Model not checked: Quint models cannot be checked; TLA+ is unaffected." },
  ]) capabilities.push(await probe({ ...spec, repair: repairCommand(spec.id) }));
  const quint = capabilities.find(({ id }) => id === "quint");
  if (process.platform === "win32" && quint?.status === "available") {
    capabilities[capabilities.indexOf(quint)] = { ...quint, status: "unavailable",
      smoke: { ...quint.smoke, output: `${quint.smoke.output}\nQuint's TLC backend cannot start Apalache on Windows. Use TLA+ or Linux/WSL.` } };
  }
  try {
    const lsc = lscCommand();
    const result = await probe({ id: "lsc", ...lsc, args: [...lsc.args, "version"], consequence: proofLoss, repair: repairCommand("lsc") });
    capabilities.push({ ...result, entryPoint: lsc.args.join(" ") });
  } catch {
    capabilities.push({ id: "lsc", status: "unavailable", path: null, version: null,
      smoke: { ended: "not_started", exitCode: null, output: "LemmaScript entry point not found." }, consequence: proofLoss, repair: repairCommand("lsc") });
  }
  const jar = tlaToolsJar();
  if (!existsSync(jar)) {
    capabilities.push({ id: "tlc", status: "unavailable", path: processExecutable("java") ?? null, entryPoint: jar, version: null,
      smoke: { ended: "not_started", exitCode: null, output: "TLC jar not found." }, consequence: modelLoss, repair: repairCommand("tlc") });
  } else {
    const tlc = await probe({ id: "tlc", executable: "java", args: ["-cp", jar, "tlc2.TLC", "-help"], consequence: modelLoss,
      repair: repairCommand("tlc"), successExitCode: 1, accepts: /TLC - provides model checking.*Version \d/u });
    capabilities.push({ ...tlc, entryPoint: jar });
  }
  capabilities.push(await claudeDiagnosis("claude-code"));
  const accounts = readSettings().settings.accounts ?? [];
  for (const account of accounts) {
    if (account.provider !== "claude-code") continue;
    capabilities.push(await claudeDiagnosis(`claude-code@${account.name}`));
  }
  const credentials = fileCredentialStore();
  const stored = new Set((await credentials.list()).map(({ providerId }) => providerId));
  const models = engineModels(credentials, accounts);
  for (const provider of models.getProviders().filter(({ id }) => !id.startsWith("claude-code") && models.getModels(id).length > 0)) {
    try {
      // checkAuth reads local auth only: unlike getAuth, it never refreshes OAuth credentials.
      const auth = await models.checkAuth(provider.id, { signal: AbortSignal.timeout(5_000) });
      if (auth === undefined && !stored.has(provider.id)) continue;
      capabilities.push({ id: `provider:${provider.id}`, status: doctorStatus(true, auth !== undefined), path: null,
        version: `pi-ai ${manifest.dependencies["@earendil-works/pi-ai"]}`,
        smoke: { ended: "exited", exitCode: auth === undefined ? 1 : 0,
          output: auth === undefined ? "Stored sign-in is not usable locally." : "Local sign-in present; no model request sent or credential refreshed." },
        consequence: providerLoss, repair: `${repairCommand("provider")} (then /login)` });
    } catch {
      capabilities.push({ id: `provider:${provider.id}`, status: "failed", path: null, version: null,
        smoke: { ended: "cancelled", exitCode: null, output: "Local auth lookup failed or exceeded its five-second limit." },
        consequence: providerLoss, repair: `${repairCommand("provider")} (then /login)` });
    }
  }
  return { capabilities, exitCode: doctorExitCode(capabilities.some(({ status }) => status === "failed"),
    capabilities.some(({ status }) => status === "unavailable")) };
}

/** Both renderings use precisely the same report and exit code. */
export async function doctorCommand(args: readonly string[], output: { out(text: string): void; error(text: string): void }): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
    (help ? output.out : output.error)("Use: tesota doctor [--json]\nRead-only local probes, five seconds each. Exit: 0 available, 1 failed, 2 unavailable (failure takes precedence); 3 usage error.\n");
    return help ? 0 : 3;
  }
  const report = await doctorReport();
  output.out(formatDoctorReport(report, args[0] === "--json"));
  return report.exitCode;
}

/** Human and machine renderings share every field; formatting is not a health decision. */
export function formatDoctorReport(report: Awaited<ReturnType<typeof doctorReport>>, json: boolean): string {
  return json ? `${JSON.stringify(report, null, 2)}\n`
    : `Tesota doctor - read-only local checks (5 s per probe)\n${report.capabilities.map((item) =>
      `\n${item.id}: ${item.status}\n  Path: ${item.path ?? "not applicable / not found"}\n  Version: ${item.version ?? "unknown"}\n` +
      `${item.entryPoint === undefined ? "" : `  Entry point: ${item.entryPoint}\n`}  Smoke: ${item.smoke.ended}, exit ${item.smoke.exitCode ?? "none"}: ${item.smoke.output.replace(/\s+/gu, " ")}\n` +
      `  Without it: ${item.consequence}\n  Repair: ${item.repair}\n`).join("")}\nExit code: ${report.exitCode}\n`;
}
