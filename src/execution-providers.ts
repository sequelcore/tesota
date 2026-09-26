import { spawn } from "node:child_process";
import { dockerSandboxesProvider } from "./docker-sandboxes-environment.js";
import { confinesCommands, type ExecutionProvider, type ProviderReadiness, type SetupAction,
  type SetupStep } from "./execution-environment.js";
import { hostProvider } from "./host-environment.js";
import { windowsPowerShell } from "./windows-system.js";

/** Providers that can run commands in a sandbox, in order of preference. */
const isolatingProviders: readonly ExecutionProvider[] = [dockerSandboxesProvider]
  .filter((provider) => confinesCommands(provider.guarantees));

const allProviders: readonly ExecutionProvider[] = [...isolatingProviders, hostProvider];

/**
 * Where a session's commands run (decision 025): in a sandbox, where they run
 * without asking, or on the host, the operator's own computer, where each one
 * asks first. It follows from what is set up; nothing switches it.
 */
export type SessionExecution =
  | Readonly<{ commands: "sandbox"; provider: ExecutionProvider }>
  | Readonly<{ commands: "host"; provider: ExecutionProvider; missing: readonly Readonly<{ provider: string;
      readiness: ProviderReadiness }>[] }>;

/**
 * Commands run in a sandbox when an isolating provider is ready, and on the
 * host otherwise. There is no silent fallback: on the host every command asks
 * first.
 */
export async function chooseSessionExecution(candidates: readonly ExecutionProvider[] = isolatingProviders,
  fallback: ExecutionProvider = hostProvider): Promise<SessionExecution> {
  const missing: { provider: string; readiness: ProviderReadiness }[] = [];
  for (const provider of candidates) {
    const readiness = await provider.readiness().catch((): ProviderReadiness => ({ ready: false,
      steps: [{ description: "The provider could not report whether it is ready" }] }));
    if (readiness.ready && confinesCommands(provider.guarantees)) return { commands: "sandbox", provider };
    missing.push({ provider: provider.name, readiness });
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
    if (entry.readiness.ready) continue;
    lines.push(`${entry.provider}:`);
    for (const step of entry.readiness.steps) {
      const note = step.elevated === true ? ` (administrator PowerShell${step.restart === true ? ", then restart" : ""})` : "";
      lines.push(`  - ${step.description}${note}${step.command === undefined ? "" : `\n      ${step.command}`}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
