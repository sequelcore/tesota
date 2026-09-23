import type { IsolationInvocation } from "./command-isolation.js";
import { executeRepositoryContainer, type RepositoryContainerProcessObservation } from "./repository-container-process.js";

export interface RepositoryNodeTestLimits {
  readonly timeoutMs: 30_000;
  readonly maxOutputBytes: 262_144;
  readonly terminationWaitMs: 2_000;
}

export const REPOSITORY_NODE_TEST_LIMITS: RepositoryNodeTestLimits = Object.freeze({
  timeoutMs: 30_000, maxOutputBytes: 262_144, terminationWaitMs: 2_000,
});

export type RepositoryNodeTestExecutor = (invocation: IsolationInvocation, containerName: string,
  signal?: AbortSignal) => Promise<RepositoryContainerProcessObservation>;

export function executeRepositoryNodeTestContainer(invocation: IsolationInvocation, containerName: string,
  signal?: AbortSignal): Promise<RepositoryContainerProcessObservation> {
  return executeRepositoryContainer(invocation, containerName, REPOSITORY_NODE_TEST_LIMITS, signal);
}
