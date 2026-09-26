import { spawn } from "node:child_process";
import { dockerSandboxesProvider } from "./docker-sandboxes-environment.js";
import { allowsAutonomy, type ExecutionProvider, type ProviderReadiness, type SetupAction,
  type SetupStep } from "./execution-environment.js";
import { hostProvider } from "./host-environment.js";
import { windowsPowerShell } from "./windows-system.js";

/** Providers that can confine commands enough for autonomous sessions, in order of preference. */
const isolatingProviders: readonly ExecutionProvider[] = [dockerSandboxesProvider]
  .filter((provider) => allowsAutonomy(provider.guarantees));

const allProviders: readonly ExecutionProvider[] = [...isolatingProviders, hostProvider];

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
  readonly check?: () => Promise<SessionMode>;
}

function nextStep(mode: SessionMode): SetupStep | undefined {
  if (mode.mode === "autonomous") return undefined;
  return mode.missing.flatMap((entry) => entry.readiness.ready ? [] : entry.readiness.steps)[0];
}

/**
 * Take the operator through what autonomous sessions still need: show the
 * next step and its command, run it once they confirm, and check again. It
 * stops at a restart, a failure, a step only the operator can do, or a
 * refusal, and never runs a step twice.
 */
export async function runSetup(runner: SetupRunner): Promise<number> {
  const check = runner.check ?? (() => chooseSessionMode());
  const attempted = new Set<string>();
  for (;;) {
    const mode = await check();
    const step = nextStep(mode);
    if (mode.mode === "autonomous" || step === undefined) { runner.write(formatSetup(mode)); return mode.mode === "autonomous" ? 0 : 1; }
    if (step.action === undefined || runner.confirm === null || attempted.has(step.description)) {
      if (attempted.has(step.description)) runner.write(`"${step.description}" is still missing after running it.\n\n`);
      runner.write(formatSetup(mode));
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
