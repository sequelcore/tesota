import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as z from "zod";
import { isGitObjectId, operatorLineEndingSetting, runRepositoryGit as git } from "./repository-git.js";
import { RequestRecord } from "./request-record.js";
import { DEFAULT_SOURCES_ROOT, isGitRepository, openShadow, shadowEnvironment, sourceRoot, type SourceKind }
  from "./source-shadow.js";
import { SourceSnapshot } from "./source-snapshot.js";
import { candidateStart } from "./verification/review-start-rule.js";
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
  /**
   * Paths the turn changed that the agent's own file tools did not write: its
   * commands wrote them, or the operator did during the turn, which cannot be
   * told apart. Reverting asks before it touches one of them.
   */
  readonly outside: readonly string[];
}

const treeId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const recordSchema = z.strictObject({
  format: z.literal("tesota-source-session"),
  version: z.literal(1),
  source: z.string().refine(isAbsolute),
  shadow: z.string().refine(isAbsolute),
  /** The tree when the session started, or when the operator last kept its work. */
  base: treeId,
  turns: z.array(z.strictObject({ before: treeId, after: treeId, outside: z.array(z.string()).default([]) })),
  /** The tree before a turn that has begun and not ended, such as one a crash interrupted. */
  started: treeId.optional(),
  /**
   * Turns reverted since the last new turn, the latest last, with the paths
   * each revert left as the turn left them, so a revert can be redone.
   */
  reverted: z.array(z.strictObject({ before: treeId, after: treeId, outside: z.array(z.string()),
    left: z.array(z.string()) })).default([]),
});
type SessionRecord = z.infer<typeof recordSchema>;

/** What reverting the latest turn did: the paths it restored, and those it left because they changed since. */
export interface RevertedTurn {
  readonly restored: readonly string[];
  readonly changedSince: readonly string[];
  /** Paths the operator chose to leave as the turn left them. */
  readonly left: readonly string[];
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

/**
 * Whether the session saved in `directory` has a turn begun or undecided, read
 * at once so a new session can be placed before any wait; a record that cannot
 * be read counts as undecided, so its turns are never taken for decided.
 */
export function hasUndecidedTurns(directory: string): boolean {
  try {
    const path = join(directory, recordFile);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1_048_576) return true;
    const parsed = recordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return !parsed.success || parsed.data.turns.length > 0 || parsed.data.started !== undefined;
  } catch { return true; }
}

export class SourceSession implements CheckTarget {
  /** Where the session works, telling a workspace from a session in the source. */
  readonly place = "source" as const;
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
    const record: SessionRecord = { format: "tesota-source-session", version: 1, source, shadow, base: snapshot.capture(), turns: [],
      reverted: [] };
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

  /**
   * Record the source after the turn, and return the latest undecided turn
   * with what this call changed; a turn that changed nothing leaves no turn
   * to decide. `written` are the
   * paths the agent's own file tools wrote. A correction `continues` the turn
   * it corrects when nothing changed between them, so the operator decides on
   * the request and its corrections together.
   */
  async endTurn(options: { readonly written?: readonly string[]; readonly continues?: boolean } = {}):
    Promise<{ readonly latest: Turn | undefined; readonly changed: readonly WorkspaceChange[] }> {
    const before = this.#record.started ?? this.capture();
    const after = this.capture();
    const { started: _started, ...record } = this.#record;
    const written = new Set(options.written ?? []);
    const changed = this.#changes(before, after);
    const outside = changed.map((change) => change.path).filter((path) => !written.has(path));
    const latest = record.turns.at(-1);
    let turns = record.turns;
    if (options.continues === true && latest !== undefined && latest.after === before) {
      const merged = { before: latest.before, after, outside: [...new Set([...latest.outside, ...outside])].sort() };
      turns = [...turns.slice(0, -1), ...merged.before === merged.after ? [] : [merged]];
    } else if (after !== before) turns = [...turns, { before, after, outside }];
    // New work makes the reverted turns history that can no longer be redone on top of it, as an editor's redo ends.
    await this.#save({ ...record, turns, reverted: turns === record.turns ? record.reverted : [] });
    return { latest: turns.at(-1), changed };
  }

  /** The latest undecided turn as a candidate, or the base with nothing changed when there is none. */
  snapshot(): WorkspaceSnapshot {
    const turn = this.#record.turns.at(-1);
    if (turn === undefined) return { base: this.#record.base, tree: this.#record.base, changes: [], diff: "" };
    return { base: turn.before, tree: turn.after, ...this.compare(turn.before, turn.after) };
  }

  /**
   * What a review judges (#249): the undecided turns from the first one the
   * last review of changes, `reviewed`, did not cover whole, so a stopped turn
   * or the part of one a stopped correction left is never passed over; every
   * undecided turn when no review is known.
   */
  candidate(reviewed: Pick<WorkspaceSnapshot, "base" | "tree"> | undefined): WorkspaceSnapshot {
    const turns = this.#record.turns;
    const latest = turns.at(-1);
    if (latest === undefined) return this.snapshot();
    const start = candidateStart(turns.length, turns.findLastIndex((turn) => turn.after === reviewed?.tree),
      turns.findLastIndex((turn) => turn.before === reviewed?.base));
    const base = turns[start]?.before ?? latest.before;
    return { base, tree: latest.after, ...this.compare(base, latest.after) };
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

  /**
   * Record an operator request verbatim; the record starts over when no turn
   * is undecided, unless the request was steered into the turn in progress.
   * True when it started over.
   */
  recordRequest(text: string, steered = false): Promise<boolean> {
    return this.#requests.record(text, steered || this.#record.turns.length > 0);
  }

  keepRequestsOpen(open: boolean): void { this.#requests.keepOpen(open); }

  /** The operator's requests behind the undecided turns, in order. */
  requests(): Promise<readonly string[]> { return this.#requests.requests(); }

  /** Keep every undecided turn: their changes stay in the source, and its tree after them becomes the base. */
  async keep(): Promise<void> {
    const latest = this.#record.turns.at(-1);
    if (latest === undefined) return;
    await this.#save({ ...this.#record, base: latest.after, turns: [], reverted: [] });
  }

  /** The latest reverted turn that can be redone, if any. */
  get redoable(): Turn | undefined { return this.#record.reverted.at(-1); }

  /**
   * Revert the latest undecided turn: each path it changed goes back to its
   * content before the turn, through the application's move-aside, journal
   * and recovery rules run from the turn's tree to the tree before it. A path
   * edited since the turn is never replaced; it is returned instead.
   */
  async revert(root: string = DEFAULT_APPLICATIONS_ROOT, leave: readonly string[] = []): Promise<RevertedTurn | undefined> {
    const turn = this.#record.turns.at(-1);
    if (turn === undefined) return undefined;
    const all = this.#changes(turn.after, turn.before);
    const changes = all.filter((change) => !leave.includes(change.path));
    const { skipped } = await writeTreeWhereUnchanged(gitTreeReader(this.shadow),
      { base: turn.after, tree: turn.before, changes }, this.source, root);
    const left = all.map((change) => change.path).filter((path) => leave.includes(path));
    await this.#save({ ...this.#record, turns: this.#record.turns.slice(0, -1),
      reverted: [...this.#record.reverted, { ...turn, outside: [...turn.outside], left }] });
    // A path that already held its content from before the turn needed no write, and counts as restored.
    const changed = new Set(skipped);
    return { restored: changes.map((change) => change.path).filter((path) => !changed.has(path)), changedSince: skipped, left };
  }

  /**
   * Redo the latest reverted turn: the same rules run from the tree before it
   * to the turn's tree, so a path edited since the revert is never replaced;
   * the paths the revert left are already as the turn left them. The turn is
   * undecided again.
   */
  async redo(root: string = DEFAULT_APPLICATIONS_ROOT): Promise<Omit<RevertedTurn, "left"> | undefined> {
    const turn = this.#record.reverted.at(-1);
    if (turn === undefined) return undefined;
    const changes = this.#changes(turn.before, turn.after).filter((change) => !turn.left.includes(change.path));
    const { skipped } = await writeTreeWhereUnchanged(gitTreeReader(this.shadow),
      { base: turn.before, tree: turn.after, changes }, this.source, root);
    await this.#save({ ...this.#record, reverted: this.#record.reverted.slice(0, -1),
      turns: [...this.#record.turns, { before: turn.before, after: turn.after, outside: turn.outside }] });
    const changed = new Set(skipped);
    return { restored: changes.map((change) => change.path).filter((path) => !changed.has(path)), changedSince: skipped };
  }

  /** Release the trees this session pinned in the shadow, when the session is closed. */
  discard(): void {
    const prefix = `refs/tesota/sessions/${this.#id}/`;
    for (const ref of git(this.shadow, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter((entry) => entry.length > 0)) {
      git(this.shadow, ["update-ref", "-d", ref]);
    }
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
      ...record.reverted.flatMap((turn, index): [string, string][] => [[`${prefix}reverted/${index}/before`, turn.before],
        [`${prefix}reverted/${index}/after`, turn.after]]),
      ...record.started === undefined ? [] : [[`${prefix}started`, record.started] as [string, string]]]);
    const existing = git(this.shadow, ["for-each-ref", "--format=%(refname)", prefix]).split("\n").filter((ref) => ref.length > 0);
    for (const ref of existing) if (!wanted.has(ref)) git(this.shadow, ["update-ref", "-d", ref]);
    for (const [ref, tree] of wanted) git(this.shadow, ["update-ref", ref, tree]);
  }
}
