/**
 * Where a session's commands run. Providers are adapters behind this
 * interface; nothing outside them names a vendor (decision 014).
 */

export type FilesystemGuarantee = "host" | "workspace";
export type NetworkGuarantee = "open" | "allowlist";
export type SecretGuarantee = "none" | "placeholder";
export type ResourceGuarantee = "unbounded" | "bounded";

/** What a provider enforces, in Tesota's terms. Only qualified guarantees are declared. */
export interface EnvironmentGuarantees {
  readonly filesystem: FilesystemGuarantee;
  readonly network: NetworkGuarantee;
  readonly secrets: SecretGuarantee;
  readonly resources: ResourceGuarantee;
}

/**
 * How a command ended. `unconfirmed` means a stop was requested but the
 * provider could not confirm that the command and its children are gone.
 */
export type RunOutcome = "exited" | "timed_out" | "cancelled" | "not_started" | "unconfirmed";

export interface RunResult {
  readonly outcome: RunOutcome;
  /** Present only when the command exited. */
  readonly exitCode: number | null;
}

export interface RunOptions {
  /** Host path inside the workspace; providers map it to their own view. */
  readonly cwd: string;
  /** Variables to set on top of the environment's own defaults. */
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutSeconds?: number;
  readonly signal?: AbortSignal;
  readonly onOutput: (chunk: Buffer) => void;
}

/** One step a provider took to prepare an environment, such as installing a runtime. */
export interface PreparationStep {
  readonly description: string;
  readonly outcome: "done" | "failed";
  /** The end of the step's output, kept for the operator when it failed. */
  readonly output: string;
}

/**
 * What an allowlisted network refused, and a way to open more of it. A
 * destination is `host:port`, as the environment's proxy reports it.
 */
export interface NetworkControl {
  /** Destinations refused at or after this time. */
  blockedSince(time: Date): Promise<readonly string[]>;
  /** Allow these destinations in this environment until it is released. */
  allow(destinations: readonly string[]): Promise<void>;
}

/** A network destination as `host:port`, `[IPv6]:port` included; nothing else becomes a rule. */
export function isNetworkDestination(value: string): boolean {
  return /^(?:(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+|\[[0-9A-Fa-f:.]+\]):\d{1,5}$/u.test(value);
}

/** Package registries every sandbox reaches, over HTTPS, before the operator allows anything else. */
export const PACKAGE_REGISTRY_HOSTS: readonly string[] = Object.freeze([
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "files.pythonhosted.org",
  "crates.io", "index.crates.io", "static.crates.io",
  "proxy.golang.org", "sum.golang.org",
]);

/** A prepared environment for one workspace. */
export interface ExecutionEnvironment {
  readonly provider: string;
  /** The program that runs JavaScript inside, for the execution controls' probes; `node` when absent. */
  readonly javascriptRuntime?: string;
  /** Where the workspace appears to commands, when not at its own path, such as under `/mnt` in the WSL sandbox. */
  readonly commandRoot?: string;
  readonly guarantees: EnvironmentGuarantees;
  /** What preparing this environment ran now; empty when nothing was needed or it was already prepared. */
  readonly preparation: readonly PreparationStep[];
  /** Present when the environment's network is an allowlist it can report on. */
  readonly network?: NetworkControl;
  run(command: string, options: RunOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

export interface PrepareOptions {
  readonly onProgress?: (text: string) => void;
  /** The repository's package cache, shared by its sessions (decision 030); a provider's own when absent. */
  readonly cacheDirectory?: string;
  /**
   * Stops preparing: the provider releases what it had acquired and rejects.
   * A provider stops at the next point it can; an environment it finishes
   * preparing anyway is still released through `dispose`.
   */
  readonly signal?: AbortSignal;
}

/**
 * How Tesota can run a setup step itself once the operator confirms: a
 * program with arguments, or a PowerShell script behind an administrator prompt.
 */
export type SetupAction =
  | Readonly<{ kind: "process"; program: string; args: readonly string[] }>
  | Readonly<{ kind: "elevated-powershell"; script: string }>;

/** One thing the operator must do before a provider can be used. */
export interface SetupStep {
  readonly description: string;
  /** The command that does it, when there is one. */
  readonly command?: string;
  /** Whether the command needs an administrator prompt, and a restart after. */
  readonly elevated?: boolean;
  readonly restart?: boolean;
  /** Present when Tesota can run the step; otherwise only the operator can. */
  readonly action?: SetupAction;
}

export type ProviderReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; steps: readonly SetupStep[] }>;

export interface ExecutionProvider {
  readonly name: string;
  readonly guarantees: EnvironmentGuarantees;
  /** Whether this machine can use the provider now, and what is missing otherwise. */
  readiness(): Promise<ProviderReadiness>;
  prepare(workspace: string, options?: PrepareOptions): Promise<ExecutionEnvironment>;
  /**
   * What qualification on the operator's machine depends on, such as the
   * operating system build and the provider's version (decision 030). A
   * provider without it is trusted on its declared guarantees, which its live
   * suite qualifies.
   */
  fingerprint?(): Promise<string>;
  /** Remove anything the provider keeps for a workspace that is being deleted. */
  release(workspace: string): Promise<void>;
}

/** Commands run in a sandbox, without asking, only where files and network are both confined. */
export function confinesCommands(guarantees: EnvironmentGuarantees): boolean {
  return guarantees.filesystem === "workspace" && guarantees.network === "allowlist";
}
