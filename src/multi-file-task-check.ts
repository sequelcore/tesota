import { createHash } from "node:crypto";
import type { CandidateTaskOracleResult } from "./candidate-task-definition.js";

export const MULTI_FILE_TASK_FILES: readonly ["README.md", "docs/identity.md"] = ["README.md", "docs/identity.md"];
export const MULTI_FILE_TASK_OBJECTIVE = "Record write-set-bound multi-file task status in both owning orientation documents without changing any other byte.";
export const MULTI_FILE_TASK_ORACLE = "Exact expansion of the multi-file task status in README.md and docs/identity.md.";

const statusByFile: Readonly<Record<(typeof MULTI_FILE_TASK_FILES)[number], { old: string; current: string }>> = {
  "README.md": {
    old: "application-registered, bounded tasks through one shared engine, including a two-file task.",
    current: "application-registered, bounded tasks through one shared engine, including a two-file task whose checks and review bind the complete write set.",
  },
  "docs/identity.md": {
    old: "Tesota executes a small application-owned registry of bounded tasks, including a two-file task;",
    current: "Tesota executes a small application-owned registry of bounded tasks, including a two-file task with write-set-bound checks and review;",
  },
};

function replaceExactly(source: string, from: string, to: string): string {
  if (source.split(from).length !== 2) throw new Error("Multi-file task is not applicable to this baseline");
  return source.replace(from, to);
}

export function expectedMultiFileTask(files: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(MULTI_FILE_TASK_FILES.map((path) => {
    const source = files[path];
    if (source === undefined) throw new Error("Multi-file task input unavailable");
    const status = statusByFile[path];
    return [path, replaceExactly(source, status.old, status.current)];
  }));
}

export function checkMultiFileTask(files: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>): CandidateTaskOracleResult {
  const diagnostics = MULTI_FILE_TASK_FILES.filter((path) => files[path] !== expected[path])
    .map((path) => `${path} must match its baseline multi-file status`);
  return diagnostics.length === 0 ? { status: "passed" } : { status: "check_failed", diagnostics };
}

export function multiFileTaskVerifierSha256(): string {
  return createHash("sha256").update(JSON.stringify(statusByFile)).digest("hex");
}
