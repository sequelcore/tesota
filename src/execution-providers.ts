import { dockerSandboxesProvider } from "./docker-sandboxes-environment.js";
import { allowsAutonomy, type ExecutionProvider, type ProviderReadiness } from "./execution-environment.js";
import { hostProvider } from "./host-environment.js";

/** Providers that can confine commands enough for autonomous sessions, in order of preference. */
export const isolatingProviders: readonly ExecutionProvider[] = [dockerSandboxesProvider]
  .filter((provider) => allowsAutonomy(provider.guarantees));

export const allProviders: readonly ExecutionProvider[] = [...isolatingProviders, hostProvider];

export type SessionMode =
  | Readonly<{ mode: "autonomous"; provider: ExecutionProvider }>
  | Readonly<{ mode: "supervised"; provider: ExecutionProvider; missing: readonly Readonly<{ provider: string;
      readiness: ProviderReadiness }>[] }>;

/**
 * Sessions are autonomous when an isolating provider is ready, and supervised
 * on the host otherwise. There is no silent fallback: supervised mode asks
 * before every command.
 */
export async function chooseSessionMode(candidates: readonly ExecutionProvider[] = isolatingProviders,
  fallback: ExecutionProvider = hostProvider): Promise<SessionMode> {
  const missing: { provider: string; readiness: ProviderReadiness }[] = [];
  for (const provider of candidates) {
    const readiness = await provider.readiness().catch((): ProviderReadiness => ({ ready: false,
      steps: [{ description: "The provider could not report whether it is ready" }] }));
    if (readiness.ready && allowsAutonomy(provider.guarantees)) return { mode: "autonomous", provider };
    missing.push({ provider: provider.name, readiness });
  }
  return { mode: "supervised", provider: fallback, missing };
}

/** Release every provider's resources for a workspace checkout that is being deleted. */
export async function releaseWorkspace(checkout: string, providers: readonly ExecutionProvider[] = allProviders): Promise<void> {
  for (const provider of providers) await provider.release(checkout).catch(() => undefined);
}

export function formatSetup(mode: SessionMode): string {
  if (mode.mode === "autonomous") return `Autonomous sessions are ready (${mode.provider.name}).\n`;
  const lines = ["Autonomous sessions are not available yet; sessions ask before each command.", ""];
  for (const entry of mode.missing) {
    if (entry.readiness.ready) continue;
    lines.push(`${entry.provider}:`);
    for (const step of entry.readiness.steps) {
      const note = step.elevated === true ? ` (administrator PowerShell${step.restart === true ? ", then restart" : ""})` : "";
      lines.push(`  - ${step.description}${note}${step.command === undefined ? "" : `\n      ${step.command}`}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
