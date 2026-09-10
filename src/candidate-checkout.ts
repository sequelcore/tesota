import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod";

const gitLimit = 8 * 1024 * 1024;
const gitTimeoutMs = 60_000;

const checkoutRecordSchema = z.strictObject({
  format: z.literal("tesota-candidate-checkout"),
  version: z.literal(1),
  source: z.string().refine(isAbsolute),
  baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  sourceDirty: z.boolean(),
  state: z.enum(["preparing", "ready", "failed"]),
});
type CheckoutRecord = z.infer<typeof checkoutRecordSchema>;

export interface CandidateCheckout {
  readonly directory: string;
  readonly checkout: string;
  readonly baseline: string;
  readonly sourceDirty: boolean;
}

export interface CheckoutInspection extends CandidateCheckout {
  readonly provenance: "recorded_untrusted";
  readonly head: string;
  readonly headChanged: boolean;
  readonly changes: readonly { readonly status: string; readonly path: string }[];
}

/** Git receives no caller-selected commands, shell, credentials, config or network route. */
function git(cwd: string, args: readonly string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C" });
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-c", "submodule.recurse=false",
    "-c", "core.autocrlf=false", ...args], {
    cwd, env, windowsHide: true, shell: false, encoding: "utf8", timeout: gitTimeoutMs, maxBuffer: gitLimit,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new Error("Candidate Git operation failed");
  return result.stdout;
}

function oid(value: unknown): value is string { return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value); }
function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function plainDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(absolute, actual) !== "") throw new Error("Candidate directory redirected");
  return actual;
}

async function saveRecord(directory: string, record: CheckoutRecord): Promise<void> {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(directory, "checkout.json"));
}

async function readRecord(directory: string): Promise<CheckoutRecord> {
  const path = join(directory, "checkout.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error("Invalid candidate record");
  const file = await open(path, "r");
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(16_385);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > 16_384) throw new Error("Invalid candidate record");
    bytes = bytes.subarray(0, length);
  } finally { await file.close(); }
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const parsed = checkoutRecordSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid candidate record");
  return parsed.data;
}

function validateTree(checkout: string, baseline: string): void {
  const entries = git(checkout, ["ls-tree", "-r", "-z", "--full-tree", baseline]).split("\0").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !/^(100644|100755) blob [a-f0-9]+\t/.test(entry))) {
    throw new Error("Candidate requires regular tracked files; submodules and symbolic links are unsupported");
  }
}

async function independentCheckout(directory: string): Promise<string> {
  const checkout = await plainDirectory(join(directory, "repo"));
  const dotGit = await plainDirectory(join(checkout, ".git"));
  if (relative(checkout, git(checkout, ["rev-parse", "--show-toplevel"]).trim()) !== "" ||
      relative(dotGit, git(checkout, ["rev-parse", "--absolute-git-dir"]).trim()) !== "" ||
      resolve(checkout, git(checkout, ["rev-parse", "--git-common-dir"]).trim()) !== dotGit ||
      git(checkout, ["remote"]).trim() !== "") throw new Error("Candidate Git storage is not independent");
  for (const file of ["objects/info/alternates", "objects/info/http-alternates"]) {
    try { await lstat(join(dotGit, file)); } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Candidate object storage is shared");
  }
  return checkout;
}

/** Clone committed HEAD only; preserve dirty source files, refs, config and worktree state. */
export async function createCandidateCheckout(sourceDirectory: string,
  candidatesRoot: string = join(homedir(), ".tesota", "candidates")): Promise<CandidateCheckout> {
  const source = await realpath(git(resolve(sourceDirectory), ["rev-parse", "--show-toplevel"]).trim());
  const baseline = git(source, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!oid(baseline)) throw new Error("Invalid source revision");
  validateTree(source, baseline);
  const sourceDirty = git(source, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length !== 0;
  const root = resolve(candidatesRoot);
  if (contains(source, root) || contains(root, source)) throw new Error("Candidate storage must be separate from source");
  let ancestor = root;
  for (;;) {
    try { await lstat(ancestor); break; } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  await plainDirectory(ancestor);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await plainDirectory(root);
  const directory = join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const record: CheckoutRecord = { format: "tesota-candidate-checkout", version: 1, source, baseline, sourceDirty, state: "preparing" };
  await saveRecord(directory, record);
  try {
    const template = join(directory, "empty-template");
    await mkdir(template);
    const checkout = join(directory, "repo");
    git(directory, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", "--no-tags", "--depth", "1",
      "--single-branch", `--template=${template}`, "--", source, checkout]);
    validateTree(checkout, baseline);
    git(checkout, ["checkout", "--detach", baseline, "--"]);
    git(checkout, ["remote", "remove", "origin"]);
    await independentCheckout(directory);
    if (git(checkout, ["rev-parse", "HEAD"]).trim() !== baseline ||
        git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length !== 0) throw new Error("Candidate checkout mismatch");
    await saveRecord(directory, { ...record, state: "ready" });
    return { directory, checkout, baseline, sourceDirty };
  } catch {
    await saveRecord(directory, { ...record, state: "failed" }).catch(() => {});
    throw new Error(`Candidate creation failed; incomplete state retained at ${directory}`);
  }
}

/** Read-only observations; stored records do not grant task or promotion authority. */
export async function inspectCandidateCheckout(path: string): Promise<CheckoutInspection> {
  const directory = await plainDirectory(path);
  const record = await readRecord(directory);
  if (record.state !== "ready") throw new Error(`Candidate is ${record.state}; retained at ${directory}`);
  const checkout = await independentCheckout(directory);
  if (contains(record.source, checkout) || contains(checkout, record.source)) throw new Error("Candidate overlaps source");
  const head = git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!oid(head)) throw new Error("Invalid candidate revision");
  const fields = git(checkout, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-status", "-z", record.baseline, "--"]).split("\0");
  fields.pop();
  const changes: { status: string; path: string }[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const changedPath = fields[index + 1];
    if (status === undefined || changedPath === undefined) throw new Error("Invalid Git change report");
    changes.push({ status, path: changedPath });
  }
  for (const name of git(checkout, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean)) changes.push({ status: "?", path: name });
  for (const name of git(checkout, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).split("\0").filter(Boolean)) changes.push({ status: "!", path: name });
  return { directory, checkout, baseline: record.baseline, sourceDirty: record.sourceDirty,
    provenance: "recorded_untrusted", head, headChanged: head !== record.baseline, changes };
}

/** Review the tracked diff with the same isolated Git configuration as inspection. */
export async function candidateDiff(directory: string): Promise<string> {
  const inspection = await inspectCandidateCheckout(directory);
  return git(inspection.checkout, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", inspection.baseline, "--"]);
}

/** Fixed-path task consumers can bind their inputs to the recorded commit. */
export async function readCandidateBaselineFiles(directory: string, paths: readonly string[]): Promise<{
  baseline: string; files: Readonly<Record<string, string>>;
}> {
  if (paths.some((path) => !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path) || path.split("/").some((part) => part === ".." || part === ".git"))) {
    throw new Error("Candidate baseline path denied");
  }
  const inspection = await inspectCandidateCheckout(directory);
  const files: Record<string, string> = {};
  for (const path of paths) files[path] = git(inspection.checkout, ["cat-file", "blob", inspection.baseline + ":" + path]);
  return { baseline: inspection.baseline, files };
}
