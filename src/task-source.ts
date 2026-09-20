import { lstat } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { inspectPromotionSource } from "./candidate-checkout.js";
import { readRepositoryInput, sha256 } from "./repository-check-input.js";
import { TASK_LIMITS } from "./task-contract.js";

export const taskSourceInputsSchema: z.ZodRecord<z.ZodString, z.ZodObject<{
  sha256: z.ZodString; mode: z.ZodNumber;
}>> = z.record(z.string(), z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  mode: z.number().int().min(0).max(0o777),
}));
export type TaskSourceInputs = z.infer<typeof taskSourceInputsSchema>;

/** Admit exact blob bytes or their uniform CRLF representation without Git filters. */
export function matchesTaskBaseline(digest: string, baseline: string): boolean {
  if (digest === sha256(baseline)) return true;
  // Admit only the bounded LF -> CRLF representation of a UTF-8 text blob.
  // This does not run Git filters or normalize the bytes later used for drift checks.
  return !baseline.includes("\r") && !baseline.includes("\0") &&
    digest === sha256(baseline.replaceAll("\n", "\r\n"));
}

/** Validate persisted observations against the committed files, never current source bytes. */
export function validateTaskSourceInputs(inputs: TaskSourceInputs, paths: readonly string[],
  baseline: Readonly<Record<string, string>>): void {
  if (Object.keys(inputs).length !== paths.length || !paths.every((path) => {
    const input = inputs[path];
    const content = baseline[path];
    return input !== undefined && content !== undefined && matchesTaskBaseline(input.sha256, content);
  })) throw new Error("Task source binding invalid");
}

/** Capture the exact source targets before candidate editing is possible. */
export async function captureTaskSourceInputs(directory: string, source: string, paths: readonly string[],
  baseline: Readonly<Record<string, string>>): Promise<TaskSourceInputs> {
  const inputs: TaskSourceInputs = {};
  for (const path of paths) {
    const identity = await inspectPromotionSource(directory, source, path);
    const target = join(identity.source, path);
    const before = await readRepositoryInput(target, TASK_LIMITS.fileBytes);
    const mode = (await lstat(target)).mode & 0o777;
    const after = await readRepositoryInput(target, TASK_LIMITS.fileBytes);
    if (!before.equals(after) || ((await lstat(target)).mode & 0o777) !== mode) {
      throw new Error("Task source changed during capture");
    }
    inputs[path] = { sha256: sha256(before), mode };
  }
  validateTaskSourceInputs(inputs, paths, baseline);
  return inputs;
}
