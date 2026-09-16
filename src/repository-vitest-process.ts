import type { IsolationInvocation } from "./command-isolation.js";
import { executeRepositoryContainer, type RepositoryContainerProcessObservation } from "./repository-container-process.js";

export interface RepositoryVitestLimits {
  readonly timeoutMs: 30_000;
  readonly maxOutputBytes: 262_144;
  readonly terminationWaitMs: 2_000;
}

export const REPOSITORY_VITEST_LIMITS: RepositoryVitestLimits = Object.freeze({
  timeoutMs: 30_000, maxOutputBytes: 262_144, terminationWaitMs: 2_000,
});

export type RepositoryVitestProcessObservation = RepositoryContainerProcessObservation;
export type RepositoryVitestExecutor = (invocation: IsolationInvocation, containerName: string,
  signal?: AbortSignal) => Promise<RepositoryVitestProcessObservation>;

/** Run the fixed Vitest invocation through the shared container-settlement boundary. */
export function executeRepositoryVitestContainer(invocation: IsolationInvocation, containerName: string,
  signal?: AbortSignal): Promise<RepositoryVitestProcessObservation> {
  return executeRepositoryContainer(invocation, containerName, REPOSITORY_VITEST_LIMITS, signal);
}
