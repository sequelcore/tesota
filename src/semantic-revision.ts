import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, relative } from "node:path";
import * as z from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const refinementSchema = z.string().trim().min(1).max(4096).refine((value) =>
  Buffer.byteLength(value) <= 4096 && !value.includes("\0"));

interface SemanticRevisionRecord {
  readonly format: "tesota-semantic-revision";
  readonly version: 1;
  readonly revision: "R1";
  readonly taskDefinitionSha256: string;
  readonly parentReviewSha256: string;
  readonly parentWriteSetSha256: string;
  readonly parentCheckSha256: string;
  readonly refinement: string;
  readonly refinementSha256: string;
  readonly effectiveCriteriaSha256: string;
  readonly approvedAt: string;
  readonly approval: "local_operator_assertion";
  readonly authority: "none";
}

const semanticRevisionSchema: z.ZodType<SemanticRevisionRecord> = z.strictObject({
  format: z.literal("tesota-semantic-revision"),
  version: z.literal(1),
  revision: z.literal("R1"),
  taskDefinitionSha256: digestSchema,
  parentReviewSha256: digestSchema,
  parentWriteSetSha256: digestSchema,
  parentCheckSha256: digestSchema,
  refinement: refinementSchema,
  refinementSha256: digestSchema,
  effectiveCriteriaSha256: digestSchema,
  approvedAt: z.iso.datetime(),
  approval: z.literal("local_operator_assertion"),
  authority: z.literal("none"),
});

export type SemanticRevision = z.infer<typeof semanticRevisionSchema>;

export interface SemanticRevisionRequest {
  readonly taskDefinitionSha256: string;
  readonly parentReviewSha256: string;
  readonly parentWriteSetSha256: string;
  readonly parentCheckSha256: string;
  readonly refinement: string;
  readonly approvedAt?: string;
}

interface RevisionFile {
  writeFile(data: string, encoding: "utf8"): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface RevisionFileSystem {
  open(path: string, flags: "wx", mode: number): Promise<RevisionFile>;
}

const defaultFileSystem: RevisionFileSystem = {
  open: async (path, flags, mode): Promise<FileHandle> => open(path, flags, mode),
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function effectiveCriteriaSha256(taskDefinitionSha256: string, refinement: string): string {
  return sha256(JSON.stringify({ taskDefinitionSha256, refinement: refinementSchema.parse(refinement) }));
}

export function parseSemanticRefinement(value: unknown): string {
  return refinementSchema.parse(value);
}

export function semanticRevisionSha256(record: SemanticRevision): string {
  return sha256(JSON.stringify(record));
}

export async function recordSemanticRevision(directory: string, request: SemanticRevisionRequest,
  fileSystem: RevisionFileSystem = defaultFileSystem): Promise<SemanticRevision> {
  const refinement = refinementSchema.parse(request.refinement);
  const record = semanticRevisionSchema.parse({
    format: "tesota-semantic-revision", version: 1, revision: "R1",
    taskDefinitionSha256: request.taskDefinitionSha256,
    parentReviewSha256: request.parentReviewSha256,
    parentWriteSetSha256: request.parentWriteSetSha256,
    parentCheckSha256: request.parentCheckSha256,
    refinement,
    refinementSha256: sha256(refinement),
    effectiveCriteriaSha256: effectiveCriteriaSha256(request.taskDefinitionSha256, refinement),
    approvedAt: request.approvedAt ?? new Date().toISOString(),
    approval: "local_operator_assertion",
    authority: "none",
  });
  const file = await fileSystem.open(join(directory, "semantic-revision.json"), "wx", 0o600);
  let failure: unknown;
  try {
    await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
    await file.sync();
  } catch (error) {
    failure = error;
  }
  try { await file.close(); } catch (error) { failure ??= error; }
  if (failure !== undefined) throw new Error("Semantic revision persistence failed", { cause: failure });
  return record;
}

export async function readSemanticRevision(directory: string): Promise<SemanticRevision | null> {
  const path = join(directory, "semantic-revision.json");
  let metadata;
  try { metadata = await lstat(path); } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw new Error("Semantic revision unavailable");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 16_384 ||
      relative(path, await realpath(path)) !== "") throw new Error("Semantic revision unavailable");
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(16_385);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > 16_384) throw new Error("Semantic revision unavailable");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    const record = semanticRevisionSchema.parse(value);
    if (record.refinementSha256 !== sha256(record.refinement) ||
        record.effectiveCriteriaSha256 !== effectiveCriteriaSha256(record.taskDefinitionSha256, record.refinement)) {
      throw new Error("Semantic revision identity invalid");
    }
    return record;
  } finally { await file.close(); }
}
