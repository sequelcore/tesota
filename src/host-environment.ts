import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { EnvironmentGuarantees, ExecutionEnvironment, ExecutionProvider, RunOptions, RunResult }
  from "./execution-environment.js";

const guarantees: EnvironmentGuarantees = Object.freeze({
  filesystem: "host", network: "open", secrets: "none", resources: "unbounded",
});

/**
 * Runs commands directly on this machine with the operator's permissions.
 * Pi's local shell owns process-tree termination on cancellation and timeout.
 */
export const hostProvider: ExecutionProvider = {
  name: "host",
  guarantees,
  readiness: async () => ({ ready: true }),
  prepare: async () => hostEnvironment(),
  release: async () => {},
};

function hostEnvironment(): ExecutionEnvironment {
  const shell = createLocalBashOperations();
  return {
    provider: "host",
    guarantees,
    async run(command: string, options: RunOptions): Promise<RunResult> {
      const cancelled = (): boolean => options.signal?.aborted === true;
      if (cancelled()) return { outcome: "cancelled", exitCode: null };
      try {
        const { exitCode } = await shell.exec(command, options.cwd, {
          onData: options.onOutput,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutSeconds === undefined ? {} : { timeout: options.timeoutSeconds }),
          ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
        });
        return { outcome: "exited", exitCode: exitCode ?? 1 };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (cancelled() || message === "aborted") return { outcome: "cancelled", exitCode: null };
        if (message.startsWith("timeout:")) return { outcome: "timed_out", exitCode: null };
        return { outcome: "not_started", exitCode: null };
      }
    },
    dispose: async () => {},
  };
}
