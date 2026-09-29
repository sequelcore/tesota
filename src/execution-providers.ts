import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as z from "zod";
import { dockerSandboxesProvider } from "./docker-sandboxes-environment.js";
import type { EnvironmentGuarantees, ExecutionProvider, ProviderReadiness, SetupAction, SetupStep } from "./execution-environment.js";
import { QualificationStore, type QualificationRecord, qualifyProvider } from "./execution-qualification.js";
import { hostProvider } from "./host-environment.js";
import { runsWithoutAsking } from "./verification/sandbox-qualification.js";
import { windowsPowerShell } from "./windows-system.js";
import { wslProvider } from "./wsl-environment.js";

/**
 * Where the operator wants commands to run (decisions 030 and 047): `auto`
 * prefers the WSL sandbox, then Docker Sandboxes, then this computer; the
 * others name one sandbox, or this computer, which asks before each command.
 */
export const SANDBOX_PREFERENCES = ["auto", "wsl", "docker", "host"] as const;
export type SandboxPreference = typeof SANDBOX_PREFERENCES[number];
export const DEFAULT_SANDBOX_FILE: string = join(homedir(), ".tesota", "sandbox.json");

const orders: Readonly<Record<SandboxPreference, readonly ExecutionProvider[]>> = {
  auto: [wslProvider, dockerSandboxesProvider], wsl: [wslProvider], docker: [dockerSandboxesProvider], host: [],
};

/** How the operator names each sandbox: the word they choose it by, the footer's label, and a description. */
export const SANDBOX_NAMES: Readonly<Record<string, Readonly<{ choice: SandboxPreference; label: string; described: string }>>> = {
  wsl: { choice: "wsl", label: "WSL", described: "the WSL sandbox" },
  "docker-sandboxes": { choice: "docker", label: "Docker", described: "Docker Sandboxes" },
};

/** The sandboxes to try, in order, for the operator's choice. */
export function providersFor(preference: SandboxPreference): readonly ExecutionProvider[] {
  return orders[preference];
}

const preferenceSchema = z.strictObject({ use: z.enum(SANDBOX_PREFERENCES) });

/** The operator's choice; `auto` until one is made. An unreadable file is an error, not a silent default. */
export function readSandboxPreference(path: string = DEFAULT_SANDBOX_FILE): SandboxPreference {
  if (!existsSync(path)) return "auto";
  const parsed = preferenceSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid sandbox choice; fix or delete it`);
  return parsed.data.use;
}

/** Keep the operator's choice, replacing the file whole. */
export function chooseSandboxPreference(preference: SandboxPreference, path: string = DEFAULT_SANDBOX_FILE): void {
  const content = preferenceSchema.parse({ use: preference });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/**
 * The name a sandbox keeps a repository's own state under, such as its
 * package caches and the tools its setup installed, shared by its sessions
 * (decision 030): whatever the case of its path, as Windows finds it.
 */
export function repositoryKey(repository: string): string {
  return createHash("sha256").update(resolve(repository).toLocaleLowerCase("en-US")).digest("hex");
}

const allProviders: readonly ExecutionProvider[] = [wslProvider, dockerSandboxesProvider, hostProvider];

/**
 * Where a session's commands run (decisions 025 and 030): in a sandbox, where
 * they run without asking, or on the host, the operator's own computer, where
 * each one asks first.
 */
export type SessionExecution =
  | Readonly<{ commands: "sandbox"; provider: ExecutionProvider }>
  | Readonly<{ commands: "host"; provider: ExecutionProvider; missing: readonly Readonly<{ provider: string;
      readiness: ProviderReadiness; qualification?: QualificationRecord; unconfined?: string }>[] }>;

/** What a ready provider does not confine, so its commands would still ask first; undefined when it confines both. */
export function unconfinedBy(guarantees: EnvironmentGuarantees): string | undefined {
  const files = guarantees.filesystem !== "workspace";
  const network = guarantees.network !== "allowlist";
  if (files && network) return "it confines neither files to the workspace nor the network to an allowlist";
  if (files) return "it does not confine files to the workspace";
  return network ? "it does not confine the network to an allowlist" : undefined;
}

/** A provider's qualification on this machine, or undefined when it has none to run. */
export type Trust = (provider: ExecutionProvider) => Promise<QualificationRecord | undefined>;

/**
 * Qualify a provider on this machine once per fingerprint, keeping the result;
 * `onProgress` hears when the controls run, which takes some seconds.
 */
export async function qualifyOnThisMachine(provider: ExecutionProvider, onProgress?: (text: string) => void,
  store: QualificationStore = new QualificationStore()): Promise<QualificationRecord | undefined> {
  if (provider.fingerprint === undefined) return undefined;
  const fingerprint = await provider.fingerprint();
  const kept = store.read(provider.name, fingerprint);
  if (kept !== undefined) return kept;
  onProgress?.(`Checking ${SANDBOX_NAMES[provider.name]?.described ?? provider.name} on this computer`);
  const record = await qualifyProvider(provider, { root: join(homedir(), ".tesota", "qualification-runs"),
    signal: new AbortController().signal, fingerprint });
  store.write(record);
  return record;
}

/**
 * Commands run in a sandbox when a provider is ready and its guarantees,
 * qualified on this machine when it can be, confine both files and network
 * (`runsWithoutAsking`, proved); on the host otherwise. There is no silent
 * fallback: on the host every command asks first.
 */
export async function chooseSessionExecution(candidates: readonly ExecutionProvider[] = providersFor(readSandboxPreference()),
  fallback: ExecutionProvider = hostProvider, trust: Trust = (provider) => qualifyOnThisMachine(provider)): Promise<SessionExecution> {
  const missing: { provider: string; readiness: ProviderReadiness; qualification?: QualificationRecord; unconfined?: string }[] = [];
  for (const provider of candidates) {
    const readiness = await provider.readiness().catch((): ProviderReadiness => ({ ready: false,
      steps: [{ description: "The provider could not report whether it is ready" }] }));
    const qualification = readiness.ready ? await trust(provider).catch((): QualificationRecord | undefined => undefined) : undefined;
    const guarantees = qualification?.guarantees ?? provider.guarantees;
    if (runsWithoutAsking(readiness.ready, guarantees.filesystem, guarantees.network)) return { commands: "sandbox", provider };
    const unconfined = readiness.ready ? unconfinedBy(guarantees) : undefined;
    missing.push({ provider: provider.name, readiness, ...qualification === undefined ? {} : { qualification },
      ...unconfined === undefined ? {} : { unconfined } });
  }
  return { commands: "host", provider: fallback, missing };
}

/** Release every provider's resources for a workspace checkout that is being deleted. */
export async function releaseWorkspace(checkout: string, providers: readonly ExecutionProvider[] = allProviders): Promise<void> {
  for (const provider of providers) await provider.release(checkout).catch(() => undefined);
}

/** Run a setup action with the operator's terminal attached, so sign-in and installer prompts reach them. */
export function runSetupAction(action: SetupAction): Promise<number | null> {
  const powershell = action.kind === "process" ? "" : windowsPowerShell();
  const [program, args] = action.kind === "process" ? [action.program, action.args] : [powershell, [
    "-NoProfile", "-Command",
    // The script travels encoded, so no quoting survives into the elevated process.
    `$p = Start-Process -FilePath '${powershell.replaceAll("'", "''")}' -Verb RunAs -Wait -PassThru -ArgumentList ` +
      `'-NoProfile','-EncodedCommand','${Buffer.from(action.script, "utf16le").toString("base64")}'; exit $p.ExitCode`]];
  return new Promise((settle) => {
    const child = spawn(program, args, { stdio: "inherit" });
    child.once("error", () => { settle(null); });
    child.once("close", (code) => { settle(code); });
  });
}

export interface SetupRunner {
  readonly write: (text: string) => void;
  /** Null when there is no one to ask; setup then only lists what is missing. */
  readonly confirm: ((question: string) => Promise<boolean>) | null;
  readonly run: (action: SetupAction) => Promise<number | null>;
  readonly check?: () => Promise<SessionExecution>;
}

function nextStep(execution: SessionExecution): SetupStep | undefined {
  if (execution.commands === "sandbox") return undefined;
  return execution.missing.flatMap((entry) => entry.readiness.ready ? [] : entry.readiness.steps)[0];
}

/**
 * Take the operator through what the sandbox still needs: show the
 * next step and its command, run it once they confirm, and check again. It
 * stops at a restart, a failure, a step only the operator can do, or a
 * refusal, and never runs a step twice.
 */
export async function runSetup(runner: SetupRunner): Promise<number> {
  const check = runner.check ?? (() => chooseSessionExecution());
  const attempted = new Set<string>();
  for (;;) {
    const execution = await check();
    const step = nextStep(execution);
    if (execution.commands === "sandbox" || step === undefined) {
      runner.write(formatSetup(execution));
      return execution.commands === "sandbox" ? 0 : 1;
    }
    if (step.action === undefined || runner.confirm === null || attempted.has(step.description)) {
      if (attempted.has(step.description)) runner.write(`"${step.description}" is still missing after running it.\n\n`);
      runner.write(formatSetup(execution));
      return 1;
    }
    const elevation = step.elevated === true ? " It opens an administrator prompt." : "";
    runner.write(`Next: ${step.description}.${elevation}\n  ${step.command ?? ""}\n`);
    if (!await runner.confirm("Run it now? [Y/n] ")) { runner.write("Stopped. Run tesota setup again to continue.\n"); return 1; }
    attempted.add(step.description);
    const code = await runner.run(step.action);
    if (code !== 0) { runner.write(`It did not finish (exit code ${code ?? "none"}). Nothing else was run.\n`); return 1; }
    if (step.restart === true) { runner.write("Done. Restart Windows, then run tesota setup again to continue.\n"); return 1; }
    runner.write("Done.\n\n");
  }
}

export function formatSetup(execution: SessionExecution): string {
  if (execution.commands === "sandbox") {
    return `The sandbox is ready (${execution.provider.name}): commands run in it without asking.\n`;
  }
  const lines = ["The sandbox is not ready yet: commands run on this computer and ask before each one.", ""];
  for (const entry of execution.missing) {
    const failed = entry.qualification?.results.filter((result) => !result.passed) ?? [];
    if (failed.length > 0) {
      lines.push(`${entry.provider}:`, ...failed.map((result) => `  - Its controls failed on this computer: ${result.detail}`));
      continue;
    }
    if (entry.unconfined !== undefined) lines.push(`${entry.provider}:`, `  - Ready, but ${entry.unconfined}`);
    if (entry.readiness.ready) continue;
    lines.push(`${entry.provider}:`);
    for (const step of entry.readiness.steps) {
      const note = step.elevated === true ? ` (administrator PowerShell${step.restart === true ? ", then restart" : ""})` : "";
      lines.push(`  - ${step.description}${note}${step.command === undefined ? "" : `\n      ${step.command}`}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
