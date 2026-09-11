import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { inspectPromotionSource, readCandidateBaselineFiles } from "./candidate-checkout.js";
import { CANDIDATE_TASK_LIMITS, candidateTaskDefinition } from "./candidate-task-definition.js";
import { reviewTask } from "./task-review.js";

async function capture(path: string): Promise<{ bytes: Buffer; mode: number }> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size > CANDIDATE_TASK_LIMITS.fileBytes || relative(path, await realpath(path)) !== "") {
    throw new Error("Promotion file unavailable");
  }
  const file = await open(path, "r");
  try {
    const bytes = Buffer.alloc(CANDIDATE_TASK_LIMITS.fileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const chunk = await file.read(bytes, length, bytes.length - length, null);
      if (chunk.bytesRead === 0) break;
      length += chunk.bytesRead;
    }
    if (length > CANDIDATE_TASK_LIMITS.fileBytes) throw new Error("Promotion file exceeds bound");
    return { bytes: bytes.subarray(0, length), mode: metadata.mode & 0o777 };
  } finally { await file.close(); }
}
function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Explicit invocation grants this one source write; recovered acceptance alone grants nothing. */
export async function promoteTask(directory: string, sourceDirectory: string, reviewSha256: string): Promise<{
  status: "applied"; source: string; path: string; sourceSha256: string;
}> {
  if (!/^[a-f0-9]{64}$/.test(reviewSha256)) throw new Error("Invalid review fingerprint");
  const review = await reviewTask(directory);
  const definition = candidateTaskDefinition(review.check.task);
  const accepted = (): boolean => definition.promotable &&
    review.reviewSha256 === reviewSha256 && review.check.status === "passed" &&
    review.operatorDecision?.applicability === "current" && review.operatorDecision.record.decision === "accept";
  if (!accepted()) throw new Error("Promotion requires the current accepted review");
  const taskFile = definition.writeFile;
  const source = await inspectPromotionSource(review.directory, sourceDirectory, taskFile);
  const baseline = await readCandidateBaselineFiles(review.directory, [taskFile]);
  const original = baseline.files[taskFile];
  if (original === undefined) throw new Error("Promotion baseline unavailable");
  const target = join(source.source, taskFile);
  const before = await capture(target);
  if (!before.bytes.equals(Buffer.from(original))) throw new Error("Source file changed");
  const replacement = await capture(join(review.directory, "repo", taskFile));
  if (hash(replacement.bytes) !== review.check.sourceSha256) throw new Error("Candidate changed");
  // Exclusive journal also prevents a second invocation for this candidate.
  const journal = await open(join(review.directory, "promotion.jsonl"), "wx", 0o600);
  const temporary = join(dirname(target), ".tesota-promotion-" + randomUUID() + ".tmp");
  let applied = false;
  let temporaryCreated = false;
  try {
    await journal.writeFile(JSON.stringify({ format: "tesota-task-promotion", version: 1, state: "started",
      source: source.source, head: source.head, path: taskFile, reviewSha256,
      beforeSha256: hash(before.bytes), afterSha256: hash(replacement.bytes) }) + "\n");
    await journal.sync();
    const file = await open(temporary, "wx", before.mode);
    temporaryCreated = true;
    try { await file.chmod(before.mode); await file.writeFile(replacement.bytes); await file.sync(); } finally { await file.close(); }
    const latest = await reviewTask(review.directory);
    const currentSource = await inspectPromotionSource(review.directory, source.source, taskFile);
    const current = await capture(target);
    if (latest.reviewSha256 !== reviewSha256 || latest.operatorDecision?.record.decision !== "accept" ||
        latest.operatorDecision.applicability !== "current" || currentSource.head !== source.head ||
        !current.bytes.equals(before.bytes) || current.mode !== before.mode ||
        relative(dirname(target), await realpath(dirname(target))) !== "") throw new Error("Promotion inputs changed");
    await rename(temporary, target);
    applied = true;
    if (!(await capture(target)).bytes.equals(replacement.bytes)) throw new Error("Promotion post-write mismatch");
    await journal.writeFile(JSON.stringify({ state: "applied", sourceSha256: hash(replacement.bytes) }) + "\n");
    await journal.sync();
    return { status: "applied", source: source.source, path: taskFile, sourceSha256: hash(replacement.bytes) };
  } catch {
    await journal.writeFile(JSON.stringify({ state: applied ? "applied_unconfirmed" : "not_applied" }) + "\n")
      .then(() => journal.sync()).catch(() => {});
    throw new Error("Promotion failed; inspect source and promotion journal before recovery");
  } finally {
    await journal.close();
    if (temporaryCreated) await unlink(temporary).catch(() => {});
  }
}
