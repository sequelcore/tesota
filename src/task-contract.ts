import * as z from "zod";

export const TASK_KIND = "documentation-change";
export const TASK_LIMITS: Readonly<{ reads: number; edits: number; checks: number; fileBytes: number }> =
  Object.freeze({ reads: 8, edits: 2, checks: 3, fileBytes: 64 * 1024 });

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
  writeFiles: readonly [string, ...string[]]): {
  read: z.ZodType<TaskReadRequest>;
  replace: z.ZodType<TaskReplaceRequest>;
  check: z.ZodType<Record<string, never>>;
} {
  const content = z.string().max(TASK_LIMITS.fileBytes).refine((text) =>
    Buffer.byteLength(text) <= TASK_LIMITS.fileBytes && !text.includes("\0") &&
    Buffer.from(text).toString("utf8") === text);
  return {
    read: z.strictObject({ path: z.enum(readFiles) }),
    replace: z.strictObject({ path: z.enum(writeFiles), expectedSha256: hashSchema, content }),
    check: z.strictObject({}),
  };
}
