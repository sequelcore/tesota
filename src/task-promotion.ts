import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { inspectPromotionSource, readCandidateBaselineFiles } from "./candidate-checkout.js";
import { inspectCandidateTask, taskWriteSetSha256 } from "./candidate-task.js";
import { TASK_LIMITS } from "./task-contract.js";
import { reviewTask } from "./task-review.js";

interface CapturedFile { readonly bytes: Buffer; readonly mode: number }
interface PromotionFile {
  readonly path: string;
  readonly target: string;
  readonly before: CapturedFile;
  readonly replacement: CapturedFile;
  readonly temporary: string;
}

async function capture(path: string): Promise<CapturedFile> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size > TASK_LIMITS.fileBytes || relative(path, await realpath(path)) !== "") {
    throw new Error("Promotion file unavailable");
  }
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(TASK_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > TASK_LIMITS.fileBytes) throw new Error("Promotion file exceeds bound");
    return { bytes: bytes.subarray(0, length), mode: metadata.mode & 0o777 };
  } finally { await file.close(); }
}

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

function capturedWriteSetSha256(files: readonly PromotionFile[]): string {
  const content = Object.fromEntries(files.map((file) =>
    [file.path, new TextDecoder("utf-8", { fatal: true }).decode(file.replacement.bytes)]));
  return taskWriteSetSha256(content, files.map((file) => file.path));
}

async function preparePromotionFiles(directory: string, sourceDirectory: string,
  paths: readonly string[]): Promise<{ source: string; head: string; files: readonly PromotionFile[] }> {
  const baseline = await readCandidateBaselineFiles(directory, paths);
  const files: PromotionFile[] = [];
  let sourceRoot = "";
  let sourceHead = "";
  for (const path of paths) {
    const source = await inspectPromotionSource(directory, sourceDirectory, path);
    sourceRoot ||= source.source;
    sourceHead ||= source.head;
    if (source.source !== sourceRoot || source.head !== sourceHead) throw new Error("Promotion source changed");
    const original = baseline.files[path];
    if (original === undefined) throw new Error("Promotion baseline unavailable");
    const target = join(source.source, path);
    const before = await capture(target);
    if (!before.bytes.equals(Buffer.from(original))) throw new Error("Source file changed");
    files.push({ path, target, before, replacement: await capture(join(directory, "repo", path)),
      temporary: join(dirname(target), ".tesota-promotion-" + randomUUID() + ".tmp") });
  }
  return { source: sourceRoot, head: sourceHead, files };
}

async function writeTemporaryFiles(files: readonly PromotionFile[], created: string[]): Promise<void> {
  for (const entry of files) {
    const file = await open(entry.temporary, "wx", entry.before.mode);
    created.push(entry.temporary);
    try { await file.chmod(entry.before.mode); await file.writeFile(entry.replacement.bytes); await file.sync(); }
    finally { await file.close(); }
  }
}

async function validatePromotionInputs(directory: string, source: string, head: string,
  files: readonly PromotionFile[]): Promise<void> {
  for (const entry of files) {
    const currentSource = await inspectPromotionSource(directory, source, entry.path);
    const current = await capture(entry.target);
    if (currentSource.head !== head || !current.bytes.equals(entry.before.bytes) || current.mode !== entry.before.mode ||
        relative(dirname(entry.target), await realpath(dirname(entry.target))) !== "") throw new Error("Promotion inputs changed");
  }
}

async function applyPromotionFiles(files: readonly PromotionFile[], applied: string[]): Promise<void> {
  for (const entry of files) {
    await rename(entry.temporary, entry.target);
    applied.push(entry.path);
  }
  for (const entry of files) {
    if (!(await capture(entry.target)).bytes.equals(entry.replacement.bytes)) throw new Error("Promotion post-write mismatch");
  }
}

/** Explicit invocation grants this bounded write set; recovered acceptance alone grants nothing. */
export async function promoteTask(directory: string, sourceDirectory: string, reviewSha256: string): Promise<{
  status: "applied";
  source: string;
  files: readonly { readonly path: string; readonly sourceSha256: string }[];
}> {
  if (!/^[a-f0-9]{64}$/.test(reviewSha256)) throw new Error("Invalid review fingerprint");
  const review = await reviewTask(directory);
  const task = await inspectCandidateTask(review.directory);
  const accepted = task.promotable && review.reviewSha256 === reviewSha256 && review.check.status === "passed" &&
    review.operatorDecision?.applicability === "current" && review.operatorDecision.record.decision === "accept";
  if (!accepted) throw new Error("Promotion requires the current accepted review");

  const prepared = await preparePromotionFiles(review.directory, sourceDirectory, task.writeFiles);
  const { files } = prepared;
  if (capturedWriteSetSha256(files) !== review.check.writeSetSha256) throw new Error("Candidate changed");

  const journal = await open(join(review.directory, "promotion.jsonl"), "wx", 0o600);
  const temporaryFiles: string[] = [];
  const applied: string[] = [];
  try {
    await journal.writeFile(JSON.stringify({ format: "tesota-task-promotion", version: 2, state: "started",
      source: prepared.source, head: prepared.head, reviewSha256,
      files: files.map((file) => ({ path: file.path, beforeSha256: hash(file.before.bytes),
        afterSha256: hash(file.replacement.bytes) })) }) + "\n");
    await journal.sync();
    await writeTemporaryFiles(files, temporaryFiles);
    const latest = await reviewTask(review.directory);
    if (latest.reviewSha256 !== reviewSha256 || latest.operatorDecision?.record.decision !== "accept" ||
        latest.operatorDecision.applicability !== "current" || latest.check.writeSetSha256 !== capturedWriteSetSha256(files)) {
      throw new Error("Promotion inputs changed");
    }
    await validatePromotionInputs(review.directory, prepared.source, prepared.head, files);
    await applyPromotionFiles(files, applied);
    const resultFiles = files.map((file) => ({ path: file.path, sourceSha256: hash(file.replacement.bytes) }));
    await journal.writeFile(JSON.stringify({ state: "applied", files: resultFiles }) + "\n");
    await journal.sync();
    return { status: "applied", source: prepared.source, files: resultFiles };
  } catch {
    const state = applied.length === 0 ? "not_applied" : applied.length === files.length ? "applied_unconfirmed" : "partially_applied";
    await journal.writeFile(JSON.stringify({ state, applied }) + "\n").then(() => journal.sync()).catch(() => {});
    throw new Error("Promotion failed; inspect source and promotion journal before recovery");
  } finally {
    await journal.close();
    await Promise.all(temporaryFiles.map((path) => unlink(path).catch(() => {})));
  }
}
