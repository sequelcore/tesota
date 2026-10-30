import { processExecutable, runProcess, type ProcessRun } from "../../../src/process.ts";
import { doctorExitCode, doctorStatus } from "./doctor-rule.ts";
import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import manifest from "../package.json" with { type: "json" };
import { tlaToolsJar } from "../../../src/model-check.ts";
import { lscCommand } from "../../../src/verification/lemmascript-verifier.ts";
import { fileCredentialStore } from "./credentials.ts";
import { engineModels } from "./model-access.ts";
import { readSettings, unknownSettingsNote } from "./settings.ts";
import { tesotaHome } from "../../../src/home.ts";
import { join } from "node:path";
import { claudeCodeExecutable } from "./providers/claude-code.ts";
import install from "../../../docs/reference/installation.md" with { type: "text" };

/** A read-only, local version/help command, never a project check or a model request. */
export interface Probe {
  readonly id: string;
  readonly requirement: "core" | "optional";
  readonly executable: string;
  readonly args: readonly string[];
  readonly consequence: string;
  readonly repair: string;
  readonly accepts?: RegExp;
  readonly successExitCode?: number;
}

export interface Diagnosis {
  readonly id: string;
  readonly requirement: Probe["requirement"];
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
  return { id: spec.id, requirement: spec.requirement, status: doctorStatus(path !== undefined,
    smoke.ended === "exited" && smoke.exitCode === (spec.successExitCode ?? 0) && (spec.accepts?.test(output) ?? true)),
  path: path ?? null, version, smoke: { ended: smoke.ended, exitCode: smoke.exitCode, output: output.slice(0, 512) },
  consequence: spec.consequence, repair: spec.repair };
}

/** Repair commands are owned by docs/reference/installation.md, not a second platform-specific list. */
export function repairCommand(id: string, platform: NodeJS.Platform = process.platform): string {
  const table = install.split("<!-- doctor-repairs-start -->")[1]?.split("<!-- doctor-repairs-end -->")[0] ?? "";
  const row = table.split("\n").find((line) => line.startsWith(`| ${id} |`));
  const column = platform === "win32" ? 2 : platform === "darwin" ? 3 : 4;
  const command = row?.split("|")[column]?.trim().replace(/^`|`$/gu, "");
  if (!command) throw new Error(`No ${platform} repair command for ${id} in docs/reference/installation.md`);
  return command;
}

const proofLoss = "Not proved: LemmaScript contracts cannot be proved.";
const modelLoss = "Model not checked: design models cannot be model-checked.";
const providerLoss = "Not verified: no run with this provider until its sign-in works; other providers are unaffected.";

async function claudeDiagnosis(id: string): Promise<Diagnosis> {
  const executable = claudeCodeExecutable();
  const chosen = process.env["CLAUDE_CODE_EXECUTABLE"];
  // A stale explicit path would otherwise look like a missing install or a signed-out account.
  const repair = chosen !== undefined && !existsSync(chosen)
    ? `CLAUDE_CODE_EXECUTABLE is set to ${chosen}, which does not exist: correct it or unset it`
    : `${repairCommand("claude-code")}; then ${id === "claude-code" ? "claude (then /login)" : `tesota accounts login ${id}`}`;
  const version = await probe({ id, requirement: "optional", executable: executable ?? "claude", args: ["--version"],
    consequence: "Not verified: no run with Claude Code when its executable is unavailable; other providers are unaffected.", repair });
  // `auth status` writes .claude.json and backups. Never invoke it or read Claude's files from doctor.
  return { ...version, smoke: { ...version.smoke, output: `${version.smoke.output}\nSign-in not checked (version-only probe).` } };
}

/**
 * Collect sequential local probes. Project tests are deliberately not run: they may write or download.
 * Warnings, such as settings Tesota does not read (#714), never change the exit code.
 */
export async function doctorReport(): Promise<{ capabilities: Diagnosis[]; warnings: string[]; exitCode: number }> {
  const capabilities: Diagnosis[] = [];
  for (const spec of [
    { id: "dafny", requirement: "core" as const, executable: "dafny", args: ["--version"], consequence: proofLoss, accepts: /(?:^|\s)4\./u },
    { id: "java", requirement: "core" as const, executable: "java", args: ["-version"], consequence: modelLoss,
      accepts: /version "(?:1[1-9]|[2-9]\d|\d{3,})[."]/u },
    { id: "git", requirement: "core" as const, executable: "git", args: ["--version"], consequence: "Not verified: changes cannot be measured against a Git base or snapshot." },
    { id: "quint", requirement: "optional" as const, executable: "quint", args: ["--version"], consequence: "Model not checked: Quint models cannot be checked; TLA+ is unaffected." },
  ]) capabilities.push(await probe({ ...spec, repair: repairCommand(spec.id) }));
  const quint = capabilities.find(({ id }) => id === "quint");
  if (process.platform === "win32" && quint?.status === "available") {
    capabilities[capabilities.indexOf(quint)] = { ...quint, status: "unavailable",
      smoke: { ...quint.smoke, output: `${quint.smoke.output}\nQuint's TLC backend cannot start Apalache on Windows. Use TLA+ or Linux/WSL.` } };
  }
  try {
    const lsc = lscCommand();
    const result = await probe({ id: "lsc", requirement: "core", ...lsc, args: [...lsc.args, "version"], consequence: proofLoss, repair: repairCommand("lsc") });
    capabilities.push({ ...result, entryPoint: lsc.args.join(" ") });
  } catch {
    capabilities.push({ id: "lsc", requirement: "core", status: "unavailable", path: null, version: null,
      smoke: { ended: "not_started", exitCode: null, output: "LemmaScript entry point not found." }, consequence: proofLoss, repair: repairCommand("lsc") });
  }
  const jar = tlaToolsJar();
  if (!existsSync(jar)) {
    capabilities.push({ id: "tlc", requirement: "core", status: "unavailable", path: processExecutable("java") ?? null, entryPoint: jar, version: null,
      smoke: { ended: "not_started", exitCode: null, output: "TLC jar not found." }, consequence: modelLoss, repair: repairCommand("tlc") });
  } else {
    const tlc = await probe({ id: "tlc", requirement: "core", executable: "java", args: ["-cp", jar, "tlc2.TLC", "-help"], consequence: modelLoss,
      repair: repairCommand("tlc"), successExitCode: 1, accepts: /TLC - provides model checking.*Version \d/u });
    capabilities.push({ ...tlc, entryPoint: jar });
  }
  const providers: Diagnosis[] = [await claudeDiagnosis("claude-code")];
  const settingsPath = join(tesotaHome(), "settings.json");
  const settings = readSettings(settingsPath);
  const accounts = settings.settings.accounts ?? [];
  for (const account of accounts) {
    if (account.provider !== "claude-code") continue;
    providers.push(await claudeDiagnosis(`claude-code@${account.name}`));
  }
  const credentials = fileCredentialStore();
  const stored = new Set((await credentials.list()).map(({ providerId }) => providerId));
  const models = await engineModels(credentials, accounts);
  for (const provider of models.getProviders().filter(({ id }) => !id.startsWith("claude-code") && models.getModels(id).length > 0)) {
    try {
      // checkAuth reads local auth only: unlike getAuth, it never refreshes OAuth credentials.
      const auth = await models.checkAuth(provider.id, { signal: AbortSignal.timeout(5_000) });
      if (auth === undefined && !stored.has(provider.id)) continue;
      providers.push({ id: `provider:${provider.id}`, requirement: "optional", status: doctorStatus(true, auth !== undefined), path: null,
        version: `pi-ai ${manifest.dependencies["@earendil-works/pi-ai"]}`,
        smoke: { ended: "exited", exitCode: auth === undefined ? 1 : 0,
          output: auth === undefined ? "Stored sign-in is not usable locally." : "Local sign-in present; no model request sent or credential refreshed." },
        consequence: providerLoss, repair: `${repairCommand("provider")} (then /login)` });
    } catch {
      providers.push({ id: `provider:${provider.id}`, requirement: "optional", status: "failed", path: null, version: null,
        smoke: { ended: "cancelled", exitCode: null, output: "Local auth lookup failed or exceeded its five-second limit." },
        consequence: providerLoss, repair: `${repairCommand("provider")} (then /login)` });
    }
  }
  const providerAvailable = providers.some(({ status }) => status === "available");
  capabilities.push(...providers, { id: "model provider", requirement: "core", status: doctorStatus(providerAvailable, true),
    path: null, version: null, smoke: { ended: "exited", exitCode: providerAvailable ? 0 : 1,
      output: providerAvailable ? "At least one provider row is available; Claude Code rows are version-only, with sign-in unchecked."
        : "No provider row is available." },
    consequence: "Not verified: no run can start without a model provider.",
    repair: `${repairCommand("provider")} (then /login); Models guide: https://github.com/sequelcore/tesota/blob/main/docs/guides/models.md` });
  const unknown = unknownSettingsNote(settings.unknown, settingsPath);
  return { capabilities, warnings: unknown === undefined ? [] : [unknown], exitCode: doctorExitCode(capabilities.some(({ status }) => status === "failed"),
    capabilities.some(({ status, requirement }) => status === "unavailable" && requirement === "core")) };
}

/** Both renderings use precisely the same report and exit code. */
export async function doctorCommand(args: readonly string[], output: { out(text: string): void; error(text: string): void }): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) {
    const help = args.length === 1 && (args[0] === "--help" || args[0] === "-h");
    (help ? output.out : output.error)("Use: tesota doctor [--json]\nRead-only local probes, five seconds each. Core: Git, Dafny with lsc, Java with TLC, model provider (at least one provider row available). Optional: Quint and individual provider rows, including Claude Code accounts.\nExit: 0 no failures or unavailable core capabilities, 1 any failed tool/provider (including optional), 2 core capability unavailable without failures, 3 usage error. Unavailable optional tools do not affect the exit code, nor do warnings such as unknown settings keys.\n");
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
      `\n${item.id}: ${item.status} (${item.requirement})\n  Path: ${item.path ?? "not applicable / not found"}\n  Version: ${item.version ?? "unknown"}\n` +
      `${item.entryPoint === undefined ? "" : `  Entry point: ${item.entryPoint}\n`}  Smoke: ${item.smoke.ended}, exit ${item.smoke.exitCode ?? "none"}: ${item.smoke.output.replace(/\s+/gu, " ")}\n` +
      `  Without it: ${item.consequence}\n  Repair: ${item.repair}\n`).join("")}${report.warnings.map((warning) => `\nWarning: ${warning}\n`).join("")}`
      + `\nExit code: ${report.exitCode}\n`;
}
