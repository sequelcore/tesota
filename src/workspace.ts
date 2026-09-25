import { isGitObjectId, runRepositoryGit as git } from "./repository-git.js";
import { createWorkspaceCheckout, DEFAULT_WORKSPACES_ROOT, inspectWorkspaceCheckout } from "./workspace-checkout.js";

export type WorkspaceChangeStatus = "added" | "modified" | "deleted";

export interface WorkspaceChange {
  readonly status: WorkspaceChangeStatus;
  readonly path: string;
}

/** The exact content a review, its checks and an application refer to. */
export interface WorkspaceSnapshot {
  readonly base: string;
  readonly tree: string;
  readonly changes: readonly WorkspaceChange[];
  readonly diff: string;
}

const identity = ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "-c", "commit.gpgsign=false"];
const statusNames: Readonly<Record<string, WorkspaceChangeStatus>> = { A: "added", M: "modified", D: "deleted" };

function parseChanges(value: string): WorkspaceChange[] {
  const fields = value.split("\0");
  fields.pop();
  if (fields.length % 2 !== 0) throw new Error("Invalid Git change report");
  const changes: WorkspaceChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = statusNames[fields[index] ?? ""];
    const path = fields[index + 1];
    if (status === undefined || path === undefined) throw new Error("Unsupported workspace change");
    changes.push({ status, path });
  }
  return changes;
}

/**
 * An independent checkout the agent may change freely. Its base commit is the
 * content the source repository last agreed with; everything after it is work
 * awaiting review.
 */
export class Workspace {
  readonly directory: string;
  readonly checkout: string;
  /** The repository this workspace was cloned from and applies back to. */
  readonly source: string;
  #base: string;

  private constructor(directory: string, checkout: string, source: string, base: string) {
    this.directory = directory;
    this.checkout = checkout;
    this.source = source;
    this.#base = base;
  }

  static async create(sourceDirectory: string, root: string = DEFAULT_WORKSPACES_ROOT): Promise<Workspace> {
    const created = await createWorkspaceCheckout(sourceDirectory, root);
    return new Workspace(created.directory, created.checkout, created.source, created.head);
  }

  /** Reopen a workspace; its current HEAD becomes the base, and uncommitted work stays pending. */
  static async open(directory: string): Promise<Workspace> {
    const checkout = await inspectWorkspaceCheckout(directory);
    return new Workspace(checkout.directory, checkout.checkout, checkout.source, checkout.head);
  }

  get base(): string { return this.#base; }

  /** Stage all work and describe it relative to the base. Ignored files are not work. */
  snapshot(): WorkspaceSnapshot {
    git(this.checkout, ["add", "--all"]);
    const tree = git(this.checkout, ["write-tree"]).trim();
    if (!isGitObjectId(tree)) throw new Error("Invalid workspace tree");
    const changes = parseChanges(git(this.checkout, ["diff", "--cached", "--no-renames", "--name-status", "-z",
      this.#base, "--"]));
    const diff = git(this.checkout, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames",
      "--no-color", this.#base, "--"]);
    return { base: this.#base, tree, changes, diff };
  }

  /** Discard all work after the base, keeping ignored files such as installed dependencies. */
  revert(): void {
    git(this.checkout, ["reset", "--hard", "--quiet", this.#base]);
    git(this.checkout, ["clean", "-d", "--force", "--quiet"]);
  }

  /** Record applied work as the new base, only if the workspace still holds that exact tree. */
  settle(snapshot: WorkspaceSnapshot, message: string): void {
    if (snapshot.base !== this.#base || this.snapshot().tree !== snapshot.tree) throw new Error("Workspace changed");
    git(this.checkout, [...identity, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message]);
    const head = git(this.checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!isGitObjectId(head)) throw new Error("Invalid workspace commit");
    this.#base = head;
  }
}
