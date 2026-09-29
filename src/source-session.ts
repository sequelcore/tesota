import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod";
import { isGitObjectId, operatorLineEndingSetting, runRepositoryGit as git } from "./repository-git.js";
import { RequestRecord } from "./request-record.js";
import { DEFAULT_SOURCES_ROOT, isGitRepository, openShadow, shadowEnvironment, sourceRoot, type SourceKind }
  from "./source-shadow.js";
import { SourceSnapshot } from "./source-snapshot.js";
import { parseChanges, type WorkspaceChange, type WorkspaceSnapshot } from "./workspace.js";
import { DEFAULT_APPLICATIONS_ROOT, gitTreeReader, writeTreeWhereUnchanged } from "./workspace-apply.js";
import type { BasePlace, CheckTarget } from "./workspace-checks.js";

/**
 * A session that works in the source itself (docs/design/workspace.md): no
 * copy, and a turn is a pair of trees the source's shadow repository records,
 * the source before the turn and after it. Checks, review and correction
 * refer to those tree ids. The operator keeps a turn's changes, which are
 * already in their files, or reverts the latest turn, which restores each
 * path only while it still holds exactly what the turn left there.
 */

export const DEFAULT_SOURCE_SESSIONS_ROOT: string = join(homedir(), ".tesota", "source-sessions");

/** One turn the operator has not kept or reverted yet. */
export interface Turn {
  readonly before: string;
  readonly after: string;
}

const treeId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const recordSchema = z.strictObject({
  format: z.literal("tesota-source-session"),
  version: z.literal(1),
  source: z.string().refine(isAbsolute),
  shadow: z.string().refine(isAbsolute),
  /** The tree when the session started, or when the operator last kept its work. */
  base: treeId,
  turns: z.array(z.strictObject({ before: treeId, after: treeId })),
  /** The tree before a turn that has begun and not ended, such as one a crash interrupted. */
  started: treeId.optional(),
});
type SessionRecord = z.infer<typeof recordSchema>;

/** What reverting the latest turn did: the paths it restored, and those it left because they changed since. */
export interface RevertedTurn {
  readonly restored: readonly string[];
  readonly changedSince: readonly string[];
}

const recordFile = "session.json";
const commitIdentity = ["-c", "user.name=Tesota", "-c", "user.email=tesota@localhost", "-c", "commit.gpgsign=false"];

async function saveRecord(directory: string, record: SessionRecord): Promise<void> {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, join(directory, recordFile));
}

async function readRecord(directory: string): Promise<SessionRecord> {
  const path = join(directory, recordFile);
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) throw new Error("Invalid session record");
  const parsed = recordSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error("Invalid session record");
  return parsed.data;
}

export class SourceSession implements CheckTarget {
  readonly directory: string;
  /** The source's own directory, where the agent and its commands work. */
  readonly checkout: string;
  readonly source: string;
  readonly shadow: string;
  readonly #id: string;
  readonly #snapshot: SourceSnapshot;
  readonly #requests: RequestRecord;
  #record: SessionRecord;

  private constructor(directory: string, record: SessionRecord, snapshot: SourceSnapshot) {
    this.directory = directory;
    this.checkout = record.source;
    this.source = record.source;
    this.shadow = record.shadow;
    this.#id = directory.split(/[\\/]/u).at(-1) ?? "";
    this.#snapshot = snapshot;
    this.#requests = new RequestRecord(directory);
    this.#record = record;
  }

  /** Start a session in the source, recording the source as it is now as its base. */
  static async create(sourceDirectory: string, root: string = DEFAULT_SOURCE_SESSIONS_ROOT,
    options: { readonly sourcesRoot?: string; readonly kind?: SourceKind } = {}): Promise<SourceSession> {
    const kind = options.kind ?? (isGitRepository(sourceDirectory) ? "repository" : "folder");
    const source = await sourceRoot(sourceDirectory, kind);
    const { shadow } = await openShadow(source, kind, options.sourcesRoot ?? DEFAULT_SOURCES_ROOT);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = join(await realpath(root), randomUUID());
    await mkdir(directory, { mode: 0o700 });
    const snapshot = await SourceSnapshot.open(source, join(directory, "capture"), shadow, "shadow");
    const record: SessionRecord = { format: "tesota-source-session", version: 1, source, shadow, base: snapshot.capture(), turns: [] };
    const session = new SourceSession(directory, record, snapshot);
    await session.#save(record);
    return session;
  }

  static async open(directory: string): Promise<SourceSession> {
    const resolved = resolve(directory);
    const record = await readRecord(resolved);
    return new SourceSession(resolved, record, await SourceSnapshot.open(record.source, join(resolved, "capture"), record.shadow, "shadow"));
  }

  /** The tree when the session started, or when the operator last kept its work. */
  get base(): string { return this.#record.base; }

  /** The turns the operator has not kept or reverted, oldest first. */
  get turns(): readonly Turn[] { return this.#record.turns; }

  /** The source's tree now. */
  capture(): string { return this.#snapshot.capture(); }

  /** The base of a check runs in a checkout of its own, never in the operator's files. */
  readonly basesInOtherFolder = true;

  currentTree(): string { return this.capture(); }

  /**
   * Run `work` with the snapshot's base in a checkout of its own, made from
   * the shadow only when a check failed and removed afterwards, as a merge
   * queue tests without the patch. It is a one-commit repository, as a
   * workspace's clone is, with the operator's line endings, so a check that
   * runs Git finds one. The source is never touched.
   */
  async atBase<T>(snapshot: WorkspaceSnapshot, work: (base: BasePlace) => Promise<T>): Promise<T> {
    const ref = `refs/tesota/sessions/${this.#id}/checked`;
    const directory = join(this.directory, "base");
    const template = join(this.directory, "empty-template");
    const endings = ["-c", `core.autocrlf=${operatorLineEndingSetting(this.source)}`, "-c", "core.symlinks=false"];
    try {
      const commit = git(this.shadow, [...commitIdentity, "commit-tree", snapshot.base, "-m", "Tesota: the tree before the turn"]).trim();
      if (!isGitObjectId(commit)) throw new Error("Invalid base commit");
      git(this.shadow, ["update-ref", ref, commit]);
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
      await mkdir(template, { recursive: true });
      git(directory, ["init", "--quiet", `--template=${template}`]);
      git(directory, ["fetch", "--quiet", "--no-tags", "--depth", "1", "--", this.shadow, `+${ref}:refs/heads/base`]);
      git(directory, [...endings, "checkout", "--quiet", "--detach", "refs/heads/base"]);
      git(directory, ["config", "core.autocrlf", operatorLineEndingSetting(this.source)]);
      git(directory, ["config", "core.symlinks", "false"]);
      const intact = (): boolean => {
        try { return git(directory, [...endings, "status", "--porcelain", "--untracked-files=all"]).length === 0; }
        catch { return false; }
      };
      return await work({ directory, root: directory, intact });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      try { git(this.shadow, ["update-ref", "-d", ref]); } catch { /* never made */ }
    }
  }

  /** Record the source before a turn; a turn left begun, such as by a crash, keeps its earlier tree. */
  async beginTurn(): Promise<string> {
    if (this.#record.started !== undefined) return this.#record.started;
    const started = this.capture();
    await this.#save({ ...this.#record, started });
    return started;
  }

  /** Record the source after the turn; a turn that changed nothing leaves no turn to decide. */
  async endTurn(): Promise<Turn | undefined> {
    const before = this.#record.started ?? this.capture();
    const after = this.capture();
    const { started: _started, ...record } = this.#record;
    const turn = after === before ? undefined : { before, after };
    await this.#save({ ...record, turns: turn === undefined ? record.turns : [...record.turns, turn] });
    return turn;
  }

  /** The latest undecided turn as a candidate, or the base with nothing changed when there is none. */
  snapshot(): WorkspaceSnapshot {
    const turn = this.#record.turns.at(-1);
    if (turn === undefined) return { base: this.#record.base, tree: this.#record.base, changes: [], diff: "" };
    return { base: turn.before, tree: turn.after, ...this.compare(turn.before, turn.after) };
  }

  /** The changes and diff between two trees, such as one candidate and its correction. */
  compare(from: string, to: string): Pick<WorkspaceSnapshot, "changes" | "diff"> {
    if (!isGitObjectId(from) || !isGitObjectId(to)) throw new Error("Invalid revision");
    return {
      changes: this.#changes(from, to),
      diff: git(this.shadow, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", from, to, "--"]),
    };
  }

  /** A file as a tree holds it, or undefined when it is absent there. */
  contentAt(revision: string, path: string): string | undefined {
    if (!isGitObjectId(revision)) throw new Error("Invalid revision");
    try { return git(this.shadow, ["show", `${revision}:${path}`]); } catch { return undefined; }
  }

  /** Whether the source's Git ignores a relative path; a path it tracks, or one it cannot judge, is not ignored. */
  ignores(path: string): boolean {
    try { git(this.source, ["check-ignore", "--quiet", "--", path], shadowEnvironment(this.source, this.shadow)); return true; }
    catch { return false; }
  }

  /** Record an operator request verbatim; the record starts over when no turn is undecided. */
  recordRequest(text: string): Promise<void> { return this.#requests.record(text, this.#record.turns.length > 0); }

  keepRequestsOpen(open: boolean): void { this.#requests.keepOpen(open); }

  /** The operator's requests behind the undecided turns, in order. */
  requests(): Promise<readonly string[]> { return this.#requests.requests(); }

  /** Keep every undecided turn: their changes stay in the source, and its tree after them becomes the base. */
  async keep(): Promise<void> {
    const latest = this.#record.turns.at(-1);
    if (latest === undefined) return;
    await this.#save({ ...this.#record, base: latest.after, turns: [] });
  }

  /**
   * Revert the latest undecided turn: each path it changed goes back to its
   * content before the turn, through the application's move-aside, journal
   * and recovery rules run from the turn's tree to the tree before it. A path
   * edited since the turn is never replaced; it is returned instead.
   */
  async revert(root: string = DEFAULT_APPLICATIONS_ROOT): Promise<RevertedTurn | undefined> {
    const turn = this.#record.turns.at(-1);
    if (turn === undefined) return undefined;
    const changes = this.#changes(turn.after, turn.before);
    const { skipped } = await writeTreeWhereUnchanged(gitTreeReader(this.shadow),
      { base: turn.after, tree: turn.before, changes }, this.source, root);
    await this.#save({ ...this.#record, turns: this.#record.turns.slice(0, -1) });
    // A path that already held its content from before the turn needed no write, and counts as restored.
    const left = new Set(skipped);
    return { restored: changes.map((change) => change.path).filter((path) => !left.has(path)), changedSince: skipped };
  }

  #changes(from: string, to: string): WorkspaceChange[] {
    return parseChanges(git(this.shadow, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to, "--"]));
  }

  /**
   * Save the record, then pin every tree it names in the shadow repository,
   * so the shadow's cleanup keeps them however long the session lasts.
   */
  async #save(record: SessionRecord): Promise<void> {
    await saveRecord(this.directory, record);
    this.#record = record;
    const prefix = `refs/tesota/sessions/${this.#id}/`;
    const wanted = new Map<string, string>([[`${prefix}base`, record.base],
      ...record.turns.flatMap((turn, index): [string, string][] => [[`${prefix}${index}/before`, turn.before],
        [`${prefix}${index}/after`, turn.after]]),
      ...record.started === undefined ? [] : [[`${prefix}started`, record.started] as [string, string]]]);
    const existing = git(this.shadow, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter((ref) => ref.length > 0);
    for (const ref of existing) if (!wanted.has(ref)) git(this.shadow, ["update-ref", "-d", ref]);
    for (const [ref, tree] of wanted) git(this.shadow, ["update-ref", ref, tree]);
  }
}
