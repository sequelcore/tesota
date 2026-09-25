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

export type RunOutcome = "exited" | "timed_out" | "cancelled" | "not_started";

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

export interface ExecutionProvider {
  readonly name: string;
  readonly guarantees: EnvironmentGuarantees;
  prepare(workspace: string): Promise<ExecutionEnvironment>;
}
