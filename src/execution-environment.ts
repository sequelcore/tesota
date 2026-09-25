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

/** A prepared environment for one workspace. */
export interface ExecutionEnvironment {
  readonly provider: string;
  readonly guarantees: EnvironmentGuarantees;
  run(command: string, options: RunOptions): Promise<RunResult>;
  dispose(): Promise<void>;
}

/** One thing the operator must do before a provider can be used. */
export interface SetupStep {
  readonly description: string;
  /** The command that does it, when there is one. */
  readonly command?: string;
  /** Whether the command needs an administrator prompt, and a restart after. */
  readonly elevated?: boolean;
  readonly restart?: boolean;
}

export type ProviderReadiness =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; steps: readonly SetupStep[] }>;

export interface ExecutionProvider {
  readonly name: string;
  readonly guarantees: EnvironmentGuarantees;
  /** Whether this machine can use the provider now, and what is missing otherwise. */
  readiness(): Promise<ProviderReadiness>;
  prepare(workspace: string): Promise<ExecutionEnvironment>;
  /** Remove anything the provider keeps for a workspace that is being deleted. */
  release(workspace: string): Promise<void>;
}

/** Commands may run without asking only where files and network are both confined. */
export function allowsAutonomy(guarantees: EnvironmentGuarantees): boolean {
  return guarantees.filesystem === "workspace" && guarantees.network === "allowlist";
}
