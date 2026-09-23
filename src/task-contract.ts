import * as z from "zod";

export const TASK_KIND = "typescript-change";
export const TASK_CHECKS: readonly ["scope-integrity", "typescript-no-emit/v1"] =
  Object.freeze(["scope-integrity", "typescript-no-emit/v1"]);
export const TASK_LIMITS: Readonly<{ reads: number; edits: number; checks: number; fileBytes: number }> =
  Object.freeze({ reads: 8, edits: 2, checks: 3, fileBytes: 64 * 1024 });

export const SOURCE_TEST_TASK_KIND = "typescript-source-test-change" as const;
export const SOURCE_TEST_TASK_CHECKS: readonly ["scope-integrity", "node-test-targeted/v1"] =
  Object.freeze(["scope-integrity", "node-test-targeted/v1"]);
export const SOURCE_TEST_TASK_LIMITS: typeof TASK_LIMITS =
  Object.freeze({ reads: 12, edits: 6, checks: 6, fileBytes: 64 * 1024 });

export function taskLimits(kind: typeof TASK_KIND | typeof SOURCE_TEST_TASK_KIND): typeof TASK_LIMITS {
  return kind === SOURCE_TEST_TASK_KIND ? SOURCE_TEST_TASK_LIMITS : TASK_LIMITS;
}

export interface TaskReadRequest { readonly path: string }
export interface TaskReplaceRequest {
  readonly path: string;
  readonly expectedSha256: string;
  readonly content: string;
}

export interface TaskOracleResult {
  readonly status: "passed" | "check_failed";
  readonly diagnostics: readonly string[];
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Parsers are derived only from an admitted grant, never from model-controlled tool input. */
export function taskRequestSchemas(readFiles: readonly [string, ...string[]],
  writeFiles: readonly [string, ...string[]], limits: typeof TASK_LIMITS = TASK_LIMITS): {
  read: z.ZodType<TaskReadRequest>;
  replace: z.ZodType<TaskReplaceRequest>;
  check: z.ZodType<Record<string, never>>;
} {
  const content = z.string().max(limits.fileBytes).refine((text) =>
    Buffer.byteLength(text) <= limits.fileBytes && !text.includes("\0") &&
    Buffer.from(text).toString("utf8") === text);
  return {
    read: z.strictObject({ path: z.enum(readFiles) }),
    replace: z.strictObject({ path: z.enum(writeFiles), expectedSha256: hashSchema, content }),
    check: z.strictObject({}),
  };
}
