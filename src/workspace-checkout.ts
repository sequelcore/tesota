import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as z from "zod";
import { isGitObjectId, runRepositoryGit as git } from "./repository-git.js";

const checkoutRecordSchema = z.strictObject({
  format: z.literal("tesota-workspace-checkout"),
  version: z.literal(1),
  source: z.string().refine(isAbsolute),
  baseline: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  state: z.enum(["preparing", "ready", "failed"]),
});
type CheckoutRecord = z.infer<typeof checkoutRecordSchema>;

/** A verified, independent clone and the repository it came from. */
export interface WorkspaceCheckout {
  readonly directory: string;
  readonly checkout: string;
  readonly source: string;
  readonly baseline: string;
  readonly head: string;
}

export const DEFAULT_WORKSPACES_ROOT: string = join(homedir(), ".tesota", "workspaces");

function contains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return difference === "" || !isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`);
}

async function plainDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const metadata = await lstat(absolute);
  const actual = await realpath(absolute);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || relative(absolute, actual) !== "") {
    throw new Error("Workspace directory redirected");
  }
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
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384) throw new Error("Invalid workspace record");
  const file = await open(path, "r");
  try {
    const parsed = checkoutRecordSchema.safeParse(JSON.parse(await file.readFile("utf8")));
    if (!parsed.success) throw new Error("Invalid workspace record");
    return parsed.data;
  } finally { await file.close(); }
}

function validateTree(checkout: string, baseline: string): void {
  const entries = git(checkout, ["ls-tree", "-r", "-z", "--full-tree", baseline]).split("\0").filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !/^(100644|100755) blob [a-f0-9]+\t/.test(entry))) {
    throw new Error("Workspaces require regular tracked files; submodules and symbolic links are unsupported");
  }
}

async function independentCheckout(directory: string): Promise<{ checkout: string; head: string }> {
  const checkout = await plainDirectory(join(directory, "repo"));
  const dotGit = await plainDirectory(join(checkout, ".git"));
  const identity = git(checkout, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir",
    "HEAD^{commit}"]).trimEnd().split(/\r?\n/u);
  const [topLevel, gitDirectory, commonDirectory, head] = identity;
  if (identity.length !== 4 || topLevel === undefined || gitDirectory === undefined ||
      commonDirectory === undefined || head === undefined || relative(checkout, topLevel) !== "" ||
      relative(dotGit, gitDirectory) !== "" || resolve(checkout, commonDirectory) !== dotGit ||
      !isGitObjectId(head) || git(checkout, ["remote"]).trim() !== "") {
    throw new Error("Workspace Git storage is not independent");
  }
  for (const file of ["objects/info/alternates", "objects/info/http-alternates"]) {
    try { await lstat(join(dotGit, file)); } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Workspace object storage is shared");
  }
  return { checkout, head };
}

async function prepareRoot(path: string): Promise<string> {
  const root = resolve(path);
  let ancestor = root;
  for (;;) {
    try { await lstat(ancestor); break; } catch (error) {
      if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  await plainDirectory(ancestor);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return plainDirectory(root);
}

/** Clone the source's committed HEAD without its refs, remotes, config, hooks or uncommitted files. */
export async function createWorkspaceCheckout(sourceDirectory: string,
  workspacesRoot: string = DEFAULT_WORKSPACES_ROOT): Promise<WorkspaceCheckout> {
  const identity = git(resolve(sourceDirectory), ["rev-parse", "--show-toplevel", "HEAD^{commit}"])
    .trimEnd().split(/\r?\n/u);
  const [topLevel, baseline] = identity;
  if (identity.length !== 2 || topLevel === undefined || baseline === undefined || !isGitObjectId(baseline)) {
    throw new Error("Invalid source identity");
  }
  const source = await realpath(topLevel);
  validateTree(source, baseline);
  const requestedRoot = resolve(workspacesRoot);
  if (contains(source, requestedRoot) || contains(requestedRoot, source)) {
    throw new Error("Workspace storage must be separate from the source repository");
  }
  const root = await prepareRoot(requestedRoot);
  const directory = join(root, randomUUID());
  await mkdir(directory, { mode: 0o700 });
  const record: CheckoutRecord = { format: "tesota-workspace-checkout", version: 1, source, baseline, state: "preparing" };
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
    const cloned = await independentCheckout(directory);
    if (cloned.head !== baseline || git(checkout, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).length !== 0) {
      throw new Error("Workspace checkout mismatch");
    }
    await saveRecord(directory, { ...record, state: "ready" });
    return { directory, checkout: cloned.checkout, source, baseline, head: cloned.head };
  } catch {
    await saveRecord(directory, { ...record, state: "failed" }).catch(() => {});
    throw new Error(`Workspace creation failed; incomplete state retained at ${directory}`);
  }
}

/** Verify a saved workspace before reuse; its record describes it but grants nothing. */
export async function inspectWorkspaceCheckout(path: string): Promise<WorkspaceCheckout> {
  const directory = await plainDirectory(path);
  const record = await readRecord(directory);
  if (record.state !== "ready") throw new Error(`Workspace is ${record.state}; retained at ${directory}`);
  const { checkout, head } = await independentCheckout(directory);
  const root = dirname(directory);
  if (contains(record.source, root) || contains(root, record.source) ||
      contains(record.source, checkout) || contains(checkout, record.source)) throw new Error("Workspace overlaps source");
  return { directory, checkout, source: record.source, baseline: record.baseline, head };
}
