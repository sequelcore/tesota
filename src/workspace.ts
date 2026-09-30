import { isGitObjectId, runRepositoryGit as git } from "./repository-git.js";
import { RequestRecord } from "./request-record.js";
import type { BasePlace } from "./workspace-checks.js";
import { SourceSnapshot, UnsupportedSourceChange } from "./source-snapshot.js";
import { commitAll, createWorkspaceCheckout, type SourceOptions, DEFAULT_WORKSPACES_ROOT, inspectWorkspaceCheckout,
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

/** Git's `--name-status -z` report as changes. */
export function parseChanges(value: string): WorkspaceChange[] {
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

/** Holds the candidate's tree while the checkout holds the base for a check (decision 039). */
const pinnedCandidateRef = "refs/tesota/candidate";

/**
 * An independent checkout the agent may change freely. Its base commit is the
 * content the source repository last agreed with; everything after it is work
 * awaiting review.
 */
export class Workspace {
  /** Where the session works, telling a workspace from a session in the source. */
  readonly place = "workspace" as const;
  readonly directory: string;
  readonly checkout: string;
  /** The source this workspace was cloned from, through its shadow repository, and applies back to. */
  readonly source: string;
  /** Uncommitted source changes included when the workspace was created; empty when reopened. */
  readonly included: readonly Pick<WorkspaceChange, "status" | "path">[];
  readonly #source: SourceSnapshot;
  readonly #requests: RequestRecord;
  #base: string;

  private constructor(checkout: WorkspaceCheckout, source: SourceSnapshot) {
    this.directory = checkout.directory;
    this.checkout = checkout.checkout;
    this.source = checkout.source;
    this.included = checkout.included;
    this.#requests = new RequestRecord(checkout.directory);
    this.#source = source;
    this.#base = checkout.head;
  }

  static async create(sourceDirectory: string, root: string = DEFAULT_WORKSPACES_ROOT,
    options: SourceOptions = {}): Promise<Workspace> {
    return Workspace.from(await createWorkspaceCheckout(sourceDirectory, root, options));
  }

  /** Reopen a workspace; its current HEAD becomes the base, and uncommitted work stays pending. */
  static async open(directory: string): Promise<Workspace> {
    return Workspace.from(await inspectWorkspaceCheckout(directory));
  }

  private static async from(checkout: WorkspaceCheckout): Promise<Workspace> {
    const workspace = new Workspace(checkout, await SourceSnapshot.open(checkout.source, sourceSnapshotDirectory(checkout.directory),
      checkout.shadow));
    // A run on the base that Tesota could not finish, such as one a crash interrupted, leaves the candidate pinned.
    const pinned = workspace.#pinnedCandidate();
    if (pinned !== undefined) workspace.#restoreCandidate(pinned);
    return workspace;
  }

  get base(): string { return this.#base; }

  /** A workspace switches its own checkout to the base for a check's base run. */
  readonly basesInOtherFolder = false;

  /** The tree the checkout holds now. */
  currentTree(): string { return this.snapshot().tree; }

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
   * Whether Git ignores a relative path in the checkout, so that writing it is
   * not work; a path Git tracks, or one it cannot judge, is not ignored.
   */
  ignores(path: string): boolean {
    try { git(this.checkout, ["check-ignore", "--quiet", "--", path]); return true; } catch { return false; }
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

  /**
   * The paths where the source now differs from what the workspace last took
   * from it (decision 042); `paths` is undefined when that
   * cannot be told, such as before the first record or across a changed
   * symbolic link, and nothing counts as unchanged then.
   */
  async sourceChanges(): Promise<{ readonly paths: readonly string[] | undefined }> {
    const recorded = await this.#source.recorded();
    const tree = this.#source.capture();
    if (recorded === null) return { paths: undefined };
    if (recorded === tree) return { paths: [] };
    try { return { paths: this.#source.changes(recorded, tree).map((change) => change.path) }; }
    catch (error) { if (error instanceof UnsupportedSourceChange) return { paths: undefined }; throw error; }
  }

  /**
   * Record an operator request verbatim. The record holds the requests behind
   * the pending changes (decision 015): when nothing is pending, it starts over,
   * unless the request was steered into the turn in progress.
   */
  recordRequest(text: string, steered = false): Promise<void> {
    return this.#requests.record(text, steered || this.snapshot().changes.length > 0);
  }

  /**
   * Keep the requests pending across turns that change nothing while their
   * answer check left something not held or uncertain (decision 034), so
   * "add farewell()" followed by "continue" is still checked as one request.
   */
  keepRequestsOpen(open: boolean): void { this.#requests.keepOpen(open); }

  /** The operator's requests behind the pending changes, in order. */
  requests(): Promise<readonly string[]> { return this.#requests.requests(); }

  /** The changes and diff between two trees or commits, such as one candidate and its correction. */
  compare(from: string, to: string): Pick<WorkspaceSnapshot, "changes" | "diff"> {
    if (!isGitObjectId(from) || !isGitObjectId(to)) throw new Error("Invalid revision");
    return {
      changes: parseChanges(git(this.checkout, ["diff", "--no-renames", "--name-status", "-z", from, to, "--"])),
      diff: git(this.checkout, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", from, to, "--"]),
    };
  }

  /** A file as a commit or tree holds it, or undefined when it is absent there. */
  contentAt(revision: string, path: string): string | undefined {
    if (!isGitObjectId(revision)) throw new Error("Invalid revision");
    try { return git(this.checkout, ["show", `${revision}:${path}`]); } catch { return undefined; }
  }

  /**
   * Run `work` while the checkout holds the base instead of the candidate
   * `snapshot`, then restore the candidate exactly, as Git's own
   * `read-tree --reset -u` switches tracked files and leaves ignored ones, such
   * as installed dependencies, in place. A ref pins the candidate meanwhile, so
   * reopening the workspace restores it if Tesota stops before it could.
   * `work` is given the checkout as the base's place, with `intact`, which
   * says whether it still holds exactly the base.
   */
  async atBase<T>(snapshot: WorkspaceSnapshot, work: (base: BasePlace) => Promise<T>): Promise<T> {
    if (snapshot.base !== this.#base || this.snapshot().tree !== snapshot.tree) throw new Error("Workspace changed");
    const baseTree = git(this.checkout, ["rev-parse", "--verify", `${this.#base}^{tree}`]).trim();
    git(this.checkout, ["update-ref", pinnedCandidateRef, snapshot.tree]);
    try {
      git(this.checkout, ["read-tree", "--reset", "-u", this.#base]);
      return await work({ directory: this.checkout, intact: () => this.snapshot().tree === baseTree });
    } finally {
      this.#restoreCandidate(snapshot.tree);
    }
  }

  #pinnedCandidate(): string | undefined {
    try {
      const tree = git(this.checkout, ["rev-parse", "--verify", "--quiet", `${pinnedCandidateRef}^{tree}`]).trim();
      return isGitObjectId(tree) ? tree : undefined;
    } catch { return undefined; }
  }

  /** Put the candidate back in the index and working tree, remove what a run on the base added, and unpin it. */
  #restoreCandidate(tree: string): void {
    git(this.checkout, ["read-tree", "--reset", "-u", tree]);
    git(this.checkout, ["clean", "-d", "--force", "--quiet"]);
    if (this.snapshot().tree !== tree) throw new Error("The workspace could not be restored to the reviewed candidate");
    git(this.checkout, ["update-ref", "-d", pinnedCandidateRef]);
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
