import { existsSync, rmSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { isGitObjectId, runRepositoryGit as git } from "./repository-git.js";
import { SourceSnapshot } from "./source-snapshot.js";
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

/** Kept beside the checkout, where neither the agent's file tools nor a sandbox reach. */
const requestsFile = "requests.jsonl";
/** Present while the pending requests' answer check left gaps (decision 034). */
const openRequestsFile = "requests-open";
/** Holds the candidate's tree while the checkout holds the base for a check (decision 039). */
const pinnedCandidateRef = "refs/tesota/candidate";
const requestSchema = z.strictObject({ text: z.string().max(1_000_000), at: z.iso.datetime() });

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
      checkout.tracking));
    // A run on the base that Tesota could not finish, such as one a crash interrupted, leaves the candidate pinned.
    const pinned = workspace.#pinnedCandidate();
    if (pinned !== undefined) workspace.#restoreCandidate(pinned);
    return workspace;
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
   * Record an operator request verbatim. The record holds the requests behind
   * the pending changes (decision 015): when nothing is pending, it starts over.
   */
  async recordRequest(text: string): Promise<void> {
    const line = `${JSON.stringify(requestSchema.parse({ text, at: new Date().toISOString() }))}\n`;
    const path = join(this.directory, requestsFile);
    if (this.snapshot().changes.length === 0 && !existsSync(join(this.directory, openRequestsFile))) {
      await writeFile(path, line, { encoding: "utf8", mode: 0o600 });
    } else await appendFile(path, line, "utf8");
  }

  /**
   * Keep the requests pending across turns that change nothing while their
   * answer check left something not held or uncertain (decision 034), so
   * "add farewell()" followed by "continue" is still checked as one request.
   */
  keepRequestsOpen(open: boolean): void {
    const path = join(this.directory, openRequestsFile);
    if (open) writeFileSync(path, "", { mode: 0o600 });
    else rmSync(path, { force: true });
  }

  /** The operator's requests behind the pending changes, in order. */
  async requests(): Promise<readonly string[]> {
    const path = join(this.directory, requestsFile);
    if (!existsSync(path)) return [];
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0)
      .map((line) => requestSchema.parse(JSON.parse(line)).text);
  }

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
   * `work` is given `intact`, which says whether the checkout still holds
   * exactly the base.
   */
  async atBase<T>(snapshot: WorkspaceSnapshot, work: (intact: () => boolean) => Promise<T>): Promise<T> {
    if (snapshot.base !== this.#base || this.snapshot().tree !== snapshot.tree) throw new Error("Workspace changed");
    const baseTree = git(this.checkout, ["rev-parse", "--verify", `${this.#base}^{tree}`]).trim();
    git(this.checkout, ["update-ref", pinnedCandidateRef, snapshot.tree]);
    try {
      git(this.checkout, ["read-tree", "--reset", "-u", this.#base]);
      return await work(() => this.snapshot().tree === baseTree);
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
