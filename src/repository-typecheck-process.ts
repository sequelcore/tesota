import type { IsolationInvocation } from "./command-isolation.js";
import { executeRepositoryContainer, type RepositoryContainerProcessObservation } from "./repository-container-process.js";

export interface RepositoryTypecheckLimits {
  readonly timeoutMs: 30_000;
  readonly maxOutputBytes: 262_144;
  readonly terminationWaitMs: 2_000;
}
export const REPOSITORY_TYPECHECK_LIMITS: RepositoryTypecheckLimits = Object.freeze({
  timeoutMs: 30_000, maxOutputBytes: 262_144, terminationWaitMs: 2_000,
});

export type RepositoryTypecheckProcessObservation = RepositoryContainerProcessObservation;

export type RepositoryTypecheckExecutor = (invocation: IsolationInvocation, containerName: string,
  signal?: AbortSignal) => Promise<RepositoryTypecheckProcessObservation>;

/** Settle the Docker client and named container independently for the concrete typecheck profile. */
export function executeRepositoryTypecheckContainer(invocation: IsolationInvocation, containerName: string,
  signal?: AbortSignal): Promise<RepositoryTypecheckProcessObservation> {
  return executeRepositoryContainer(invocation, containerName, REPOSITORY_TYPECHECK_LIMITS, signal);
}
