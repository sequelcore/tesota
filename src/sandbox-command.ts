import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import type { EnvironmentGuarantees, ExecutionProvider, ProviderReadiness } from "./execution-environment.js";
import type { QualificationRecord } from "./execution-qualification.js";
import { chooseSandboxPreference, chooseSessionExecution, DEFAULT_SANDBOX_FILE, packageCacheDirectory, providersFor,
  qualifyOnThisMachine, readSandboxPreference, SANDBOX_NAMES, SANDBOX_PREFERENCES, type SandboxPreference,
  type Trust, unconfinedBy } from "./execution-providers.js";
import { dockerSandboxesProvider } from "./docker-sandboxes-environment.js";
import { hostProvider } from "./host-environment.js";
import { wslProvider } from "./wsl-environment.js";

/**
 * `tesota sandbox` (decision 030): each sandbox on this computer with what it
 * proved here, which one new sessions use, the operator's choice among them,
 * and clearing a repository's package cache and the tools sandboxes installed
 * for it.
 */

export interface SandboxCommandDependencies {
  readonly preferencePath: string;
  readonly cacheDirectory: string;
  readonly providers: (preference: SandboxPreference) => readonly ExecutionProvider[];
  /** Every sandbox to list, whatever the choice. */
  readonly candidates: readonly ExecutionProvider[];
  readonly trust: Trust;
}

export function processSandboxDependencies(repository: string = process.cwd()): SandboxCommandDependencies {
  return { preferencePath: DEFAULT_SANDBOX_FILE, cacheDirectory: packageCacheDirectory(repository), providers: providersFor,
    candidates: [wslProvider, dockerSandboxesProvider],
    trust: (provider) => qualifyOnThisMachine(provider, (text) => { process.stdout.write(`${text}...\n`); }) };
}

const described: Readonly<Record<SandboxPreference, string>> = {
  auto: "the WSL sandbox, then Docker Sandboxes, then this computer", wsl: "the WSL sandbox", docker: "Docker Sandboxes",
  host: "this computer, which asks before each command",
};
const usage = `Usage: tesota sandbox [use <${SANDBOX_PREFERENCES.join("|")}> | clean]\n`;
const hostLine = "this computer, always available; asks before each command";

function status(readiness: ProviderReadiness, qualification: QualificationRecord | undefined, declared: EnvironmentGuarantees): string {
  if (!readiness.ready) {
    return `not ready: ${readiness.steps.map((step) => `${step.description}${step.command === undefined ? "" : ` (${step.command})`}`).join("; ")}`;
  }
  const unconfined = unconfinedBy(qualification?.guarantees ?? declared);
  if (qualification === undefined) return unconfined === undefined ? "ready" : `ready, but ${unconfined}; commands ask first`;
  const failed = qualification.results.filter((result) => !result.passed);
  const day = qualification.at.slice(0, 10);
  return failed.length === 0 ? `ready; every control passed on this computer on ${day}${unconfined === undefined ? ""
    : `, but ${unconfined}; commands ask first`}` : `ready, but its controls failed on this computer on ${day}: ${failed.map((result) => result.detail).join("; ")}`;
}

async function listing(dependencies: SandboxCommandDependencies): Promise<string> {
  const preference = readSandboxPreference(dependencies.preferencePath);
  const chosen = await chooseSessionExecution(dependencies.providers(preference), hostProvider, dependencies.trust);
  const rows: string[] = [];
  for (const provider of dependencies.candidates) {
    const readiness = await provider.readiness().catch((): ProviderReadiness => ({ ready: false,
      steps: [{ description: "It could not report whether it is ready" }] }));
    const qualification = readiness.ready ? await dependencies.trust(provider).catch(() => undefined) : undefined;
    const inUse = chosen.provider === provider ? "in use: " : "";
    rows.push(`  ${(SANDBOX_NAMES[provider.name]?.choice ?? provider.name).padEnd(9)}${inUse}${status(readiness, qualification, provider.guarantees)}`);
  }
  rows.push(`  ${"host".padEnd(9)}${chosen.commands === "host" ? "in use: " : ""}${hostLine}`);
  return `Where commands run (${preference}: ${described[preference]}):\n${rows.join("\n")}\n` +
    `Change it with tesota sandbox use <${SANDBOX_PREFERENCES.join("|")}>; it applies to new sessions. ` +
    "tesota sandbox clean removes this repository's package cache and the tools sandboxes installed for it.\n";
}

export async function runSandboxCommand(args: readonly string[], write: (text: string) => void,
  dependencies: SandboxCommandDependencies = processSandboxDependencies()): Promise<number> {
  if (args.length === 0) { write(await listing(dependencies)); return 0; }
  if (args.length === 1 && args[0] === "clean") {
    const existed = existsSync(dependencies.cacheDirectory);
    await rm(dependencies.cacheDirectory, { recursive: true, force: true, maxRetries: 3 });
    for (const provider of dependencies.candidates) await provider.releaseRepository?.(dependencies.cacheDirectory);
    write(existed ? "Removed this repository's package cache and the tools sandboxes installed for it.\n"
      : "This repository has no package cache; removed any tools sandboxes installed for it.\n");
    return 0;
  }
  const [verb, choice] = args;
  if (args.length !== 2 || verb !== "use" || !(SANDBOX_PREFERENCES as readonly string[]).includes(choice ?? "")) {
    write(usage);
    return 2;
  }
  const preference = choice as SandboxPreference;
  chooseSandboxPreference(preference, dependencies.preferencePath);
  const sandbox = Object.values(SANDBOX_NAMES).find((entry) => entry.choice === preference);
  const name = preference === "auto" ? described.auto : preference === "host" ? "this computer" : sandbox?.described ?? preference;
  write(`New sessions use ${name}.\n`);
  return 0;
}
