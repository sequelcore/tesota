import { isGitObjectId, runRepositoryGit as git } from "./repository-git.js";
import { SourceSnapshot } from "./source-snapshot.js";
import { commitAll, createWorkspaceCheckout, DEFAULT_WORKSPACES_ROOT, inspectWorkspaceCheckout,
  sourceSnapshotDirectory, writeSourceChanges, type WorkspaceCheckout } from "./workspace-checkout.js";

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

/** What bringing the source repository's newer state into the workspace did. */
export type WorkspaceUpdate =
  | Readonly<{ status: "current" }>
  | Readonly<{ status: "updated"; changes: readonly WorkspaceChange[] }>
  | Readonly<{ status: "conflict"; paths: readonly string[] }>;

// A type change (T), such as a link replaced by a file, is a modification; application refuses it.
const statusNames: Readonly<Record<string, WorkspaceChangeStatus>> = { A: "added", M: "modified", T: "modified", D: "deleted" };

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

function nulSeparated(value: string): string[] { return value.split("\0").filter((entry) => entry.length > 0); }

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
  /** Uncommitted source changes included when the workspace was created; empty when reopened. */
  readonly included: readonly Pick<WorkspaceChange, "status" | "path">[];
  readonly #source: SourceSnapshot;
  #base: string;

  private constructor(checkout: WorkspaceCheckout, source: SourceSnapshot) {
    this.directory = checkout.directory;
    this.checkout = checkout.checkout;
    this.source = checkout.source;
    this.included = checkout.included;
    this.#source = source;
    this.#base = checkout.head;
  }

  static async create(sourceDirectory: string, root: string = DEFAULT_WORKSPACES_ROOT): Promise<Workspace> {
    return Workspace.from(await createWorkspaceCheckout(sourceDirectory, root));
  }

  /** Reopen a workspace; its current HEAD becomes the base, and uncommitted work stays pending. */
  static async open(directory: string): Promise<Workspace> {
    return Workspace.from(await inspectWorkspaceCheckout(directory));
  }

  private static async from(checkout: WorkspaceCheckout): Promise<Workspace> {
    return new Workspace(checkout, await SourceSnapshot.open(checkout.source, sourceSnapshotDirectory(checkout.directory)));
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

  /**
   * Bring what the source repository holds now into the workspace, as Git
   * rebases work: the newer source state becomes the base, and pending work is
   * carried onto it with a three-way merge. On a conflict nothing changes.
   */
  async update(): Promise<WorkspaceUpdate> {
    const recorded = await this.#source.recorded();
    const current = this.#source.capture();
    if (recorded === current) return { status: "current" };
    if (recorded === null) {
      await this.#source.record(current);
      return { status: "current" };
    }
    const incoming = this.#source.changes(recorded, current);
    const previous = this.#base;
    if (this.snapshot().changes.length === 0) {
      await writeSourceChanges(this.checkout, incoming);
      this.#base = commitAll(this.checkout, "Tesota: changes from the source repository");
    } else {
      const work = commitAll(this.checkout, "Tesota: pending work");
      git(this.checkout, ["reset", "--hard", "--quiet", previous]);
      await writeSourceChanges(this.checkout, incoming);
      const updated = commitAll(this.checkout, "Tesota: changes from the source repository");
      try { git(this.checkout, ["cherry-pick", "--no-commit", work]); } catch {
        const paths = nulSeparated(git(this.checkout, ["diff", "--name-only", "--diff-filter=U", "-z"]));
        git(this.checkout, ["reset", "--hard", "--quiet", work]);
        git(this.checkout, ["reset", "--mixed", "--quiet", previous]);
        return { status: "conflict", paths };
      }
      git(this.checkout, ["reset", "--mixed", "--quiet", updated]);
      this.#base = updated;
    }
    await this.#source.record(current);
    if (this.#base === previous) return { status: "current" };
    return { status: "updated", changes: parseChanges(git(this.checkout, ["diff", "--no-renames", "--name-status", "-z",
      previous, this.#base, "--"])) };
  }

  /** Discard all work after the base, keeping ignored files such as installed dependencies. */
  revert(): void {
    git(this.checkout, ["reset", "--hard", "--quiet", this.#base]);
    git(this.checkout, ["clean", "-d", "--force", "--quiet"]);
  }

  /** Record applied work as the new base, only if the workspace still holds that exact tree. */
  settle(snapshot: WorkspaceSnapshot, message: string): void {
    if (snapshot.base !== this.#base || this.snapshot().tree !== snapshot.tree) throw new Error("Workspace changed");
    git(this.checkout, ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "-c", "commit.gpgsign=false",
      "commit", "--quiet", "--no-verify", "--allow-empty", "-m", message]);
    const head = git(this.checkout, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!isGitObjectId(head)) throw new Error("Invalid workspace commit");
    this.#base = head;
  }
}
