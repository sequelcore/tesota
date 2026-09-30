# Workspace

A session in a Git repository works in the operator's own project, as local
harnesses do: the agent's changes are in the operator's files as soon as it
makes them, and each turn is recorded, so it can be checked and reviewed,
then kept or reverted. A plain folder, and a second session of the same
shell while one works in the repository, get an **isolated workspace**: an
independent clone whose changes reach the source only when the operator
applies a reviewed result.

## The shadow repository

Every source, a Git repository or a plain folder, is recorded in one
**shadow repository**: a bare repository in `~/.tesota/sources/`, named by
the source's path, compared without case only on Windows and macOS, whose
work tree is the source, the pattern people use to
version the dotfiles in their home directory (`src/source-shadow.ts`). It is
never inside the source and never the operator's own `.git`; the operator's
repository is only read. The source's `.gitignore` files and, for a
repository, its `.git/info/exclude` apply as they do to the operator's Git.
The lock files Office and LibreOffice keep while a document is open, and the
files Windows and macOS leave in folders, are excluded from every source. It
records the whole tree, since the agent works mostly through commands, which
checkpoints of its file tools alone would miss.

The shadow's `HEAD` is what later edits are measured against. For a
repository it is the operator's committed `HEAD`, fetched read-only into the
shadow whenever it moves; for a folder, or a repository without a commit, it
is the source as Tesota first found it. A superseded `HEAD` stays in the
shadow's reflog for seven days; Git's own cleanup, run at most once a day
when the shadow is opened, then removes it, as OpenCode prunes its snapshots
after seven days. Git runs with long paths on, in the shadow's own
configuration too, so a shadow under a long home path can read its packs on
Windows.

Before Tesota first records a folder, `tesota` says how many files it holds
and how large they are, and that nothing in it changes until a reviewed
result is applied, and asks once: a folder has no `.gitignore` saying what is
its work. A repository is recorded without asking, as every local harness
snapshots one; when it holds untracked, non-ignored files over 2 MB, which
every capture reads, the session names them and suggests `.gitignore`. The
home directory and a drive or file system root are refused: they hold far more
than one piece of work, credentials included. For the same reason a
directory is worked on as a repository only when its repository's top level
is neither of them: a home directory kept in Git, as dotfiles often are,
would otherwise make any folder inside it stand for the whole home, and such
a directory is worked on as a folder. File contents up to 512 MB are read
when the source changes, so a scanned PDF or a large spreadsheet can be
recorded.

Each Git worktree of a repository has a shadow of its own, holding the same
committed files again. Hermes moved from one shadow per directory to a
single shared store for this reason; Tesota waits for real use with several
worktrees before sharing one.

## Working in the source

A session in the source (`src/source-session.ts`) keeps its record in
`~/.tesota/source-sessions/<id>/`, where the agent's tools cannot reach it.

**A turn is a pair of trees.** Before the agent runs, Tesota records the
source's tree in the shadow; after it, the tree again. A turn is one request
with its correction rounds, since a correction continues the turn it
corrects, and with any message the operator sent the agent while it worked,
which joins the turn's requests; a message queued for after the turn is a turn
of its own. A turn that changed nothing leaves nothing to decide, and one that
stopped or failed still ends, so what it changed can be decided on. The
trees are pinned by refs in the shadow while the session lasts. Checks,
review and correction refer to those tree ids, so evidence stays bound to
exact content, and a correction round reviews only the tree the correction
changed. The agent is told that it works in the operator's own project and
that the operator keeps or reverts its turns, where an agent in a copy is told
its result is applied or rejected, and it is told the files the operator
changed since its last turn.

**Edits during a turn are named.** An edit the operator makes during a turn
counts as the turn's, since a command's writes and the operator's cannot be
told apart. After each turn, the session names the files it changed that the
agent's own edit and write tools did not write, and the turn keeps that list,
so its revert touches them only when the operator says so. OpenCode and Gemini CLI count such edits silently, and
Claude Code's checkpoints miss them.

**Keep, revert and redo, at any time.** A turn stays undecided after its
review, and the session goes on: the review ends with a notice, never a
prompt that holds the session, and a new request continues on top, as in
Claude Code, OpenCode, Gemini CLI and Cursor, which decide with commands or a
bar that does not block. The operator decides with commands whenever the
session is idle:

- `/keep` keeps every undecided turn: the tree after them becomes the base.
  It is the operator's acceptance, recorded in the journal apart from checks
  and review.
- `/revert` undoes the latest undecided turn, and run again steps further
  back, as OpenCode's `/undo` does. When the turn changed files outside the
  agent's tools, it names them and writes nothing until the operator runs
  `/revert all`, which reverts them too, or `/revert agent`, which leaves them
  as the turn left them.
- `/redo` puts the latest reverted turn back, undecided again, as OpenCode's
  `/redo` does, until a new turn begins.

A revert runs the application's move-aside,
journal and recovery rules below from the turn's tree back to the tree
before it (`writeTreeWhereUnchanged` in `src/workspace-apply.ts`): a path is
restored only while it still holds exactly what the turn left there, so a
file edited since is never replaced, and is named instead. A redo runs
the same rules from the tree before the turn to the turn's tree. A revert or
redo that stops partway is undone or recorded for `tesota recover`, as an
application is; one that needs recovery blocks the session, ending the prompt
that was waiting. Keep, revert and redo are journaled in the assurance
journal beside apply and reject.

**What the sandbox allows.** In the WSL sandbox commands may write the
source, with its `.git` read-only, so hooks and history cannot change, and
with files that may hold credentials hidden
([execution](execution.md#wsl-sandbox)). Checks see the hidden files only
where the operator let them, asked once when the checks are chosen and
stored with them; `/checks` shows them and `/checks reset` chooses them
again at the next review. A check's result states which hidden files it
could read. The agent is told which files are hidden from it whenever that
changes, so a command that fails without one is reported rather than worked
around. A command run on the operator's computer, which the operator
approves one at a time, sees every file, as does one in Docker Sandboxes,
whose commands ask first.

**Base checks on demand.** A failing check runs again on the tree before the
turn, [test by test](assurance.md#verifiers), in a one-commit checkout of
its own fetched from the shadow, which the WSL sandbox mounts at the
source's path for that run; it is made only when a check fails and removed
afterwards, and the operator's files are never touched.

**One session at a time, and repositories only.** Only one session of a shell
works in a repository in place; another, while it does, gets an isolated
workspace and says so, and the session store already allows one shell per
repository. Any session may choose an isolated workspace with `/isolate`
before its first request, as Claude Code's `--worktree` chooses one at
start; the choice is saved with the session, and a session keeps where it
works for its whole life, so undecided turns never move between the source
and a workspace. It keeps the earlier promise, reviewed before anything
reaches the operator's files, for an operator who wants it or keeps editing
while the agent works. A plain folder always gets an isolated workspace: its people are
often not developers, who were promised that nothing in the folder changes
until they apply a result, and a document Office holds open can be neither
written nor reverted.

## An isolated workspace

### Creating a workspace

A workspace is a clone of the shadow repository's `HEAD` under
`~/.tesota/workspaces/`, without its remotes, hooks or configuration. The
source's changes since it, a repository's uncommitted, non-ignored changes,
are captured through the shadow with a private index and object directory
kept in the workspace, so nothing is written to the source, and added as one
commit. That commit is the **base**: later diffs show only the agent's work.
Ignored files, such as `.env` or `node_modules`, are not copied.

Line endings follow the operator's `core.autocrlf` setting. Symbolic links are
checked out as plain files holding the link text (`core.symlinks=false`) and
submodules stay uninitialized; application refuses changes to either.

### Keeping it current

Before each operator request, never before a correction round, which keeps
the base its candidate was checked on ([assurance](assurance.md#correction)),
the workspace takes the source's newer state the way Git
rebases: the captured source becomes the new base, and pending work is carried
onto it with a three-way cherry-pick. If pending work conflicts with the newer
source, nothing changes and the operator is told which files; the agent is
told which files changed. The private index keeps Git's stat cache, so a
check that finds nothing new is cheap.

### Snapshots and the request record

A **snapshot** stages all work and records the changed paths, the diff and the
Git tree id. Checks, review and application all refer to that tree, so
evidence is bound to exact content: if the tree changes, the evidence no
longer applies.

The operator's requests behind the pending changes are recorded verbatim in
`requests.jsonl` beside the checkout, or beside a session's record in the
source, where the agent's tools cannot reach them (`src/request-record.ts`).
The record starts over whenever nothing is pending. Reviewers see these
requests, never the agent's own account of them.

### Applying and rejecting

Application writes exactly the reviewed tree, and only onto the
source it was checked against (`src/workspace-apply.ts`, with its proved rules
in `src/verification/application-rule.ts`).

**Admission.** Nothing is written unless three things hold, in this order:

1. No earlier application to the same source is unfinished.
2. The review still describes the workspace's exact tree and base.
3. The whole source, captured as when the workspace takes its changes, still
   equals what the workspace last took from it.

An edit anywhere in the source, even to a file the result does not touch,
refuses the application and names the changed files. The next request brings
them into the workspace, and the result is checked and reviewed again, so what
is applied is always what was checked. Each file must also still hold its
base content, and an added file must not exist yet. A CRLF checkout of the
base content counts as unchanged and keeps its line endings.

**A copy first.** Before the source changes, every original and every
reviewed file is copied, synced, into a store of its own,
`~/.tesota/applications/<id>/`, beside the workspaces. The store also holds a
manifest and a journal, so it outlives the session.

**Moving aside, never replacing.** Each changed or deleted file is renamed to
a hold beside it. This is atomic, and keeps whatever was there. The held
bytes are then compared with the original. A file that differs, such as an
edit made a moment before, is put back untouched and application stops. New
content is written and synced to a temporary file, then hard-linked to its
name. The link fails if the name exists, so a file some program creates
meanwhile is never replaced. A volume without hard links creates the file
exclusively instead. A file another program holds open, such as a document
in Office on Windows, cannot be moved aside, and stops application before
that file changes.

**Outcome.** Every file is read back. The application counts as:

- **applied** only when every file holds its reviewed content;
- **not applied** only when no file keeps an effect of it;
- **recovery required** in any other case, never reported as either of the
  first two.

A stop after the first write undoes what was written. Each original is put
back only where the journal records a write by Tesota and the path still
holds exactly what Tesota wrote, by the same move-aside step, so an edit
someone made in the meantime is never replaced. Equal content alone is not
Tesota's write: a file someone else created with the reviewed content, at a
path Tesota never wrote, stays. The journal records each step as intended
before it starts, and done or untouched after. After an interruption, an
intended step counts as Tesota's write only when the file at the path is the
very file it installed, shown by the temporary Tesota keeps linked to it
until the step is journaled, or when the step removed the path. Otherwise
whose file is there is unknown: it is left in place and the application
stays unfinished (proved). A path application never wrote counts as
unaffected, whatever someone put there.

**Recovery.** A partial effect Tesota cannot undo, or one left by a process
that ended mid-application, is recorded as recovery required. It blocks the
session and every later application to that source. `tesota recover` lists
what each path holds and settles the application in one of three ways:

- `undo` puts the originals back;
- `finish` writes the reviewed files;
- `resolved` records the operator's statement that they settled it
  themselves. This is their acceptance, not check evidence.

Undo and finish follow the same rules as application, and put back a file a
crash left moved aside. A path someone else changed is never touched. Before
writing anything, recovery checks again that every recorded path and created
directory resolves inside the source; if one now leads elsewhere, for
example through a link or junction put in its place, nothing is written and
the application stays unfinished.
Finished applications are removed from the store after 30 days; unfinished
ones stay.

After a successful application, the workspace records the applied tree as
its new base. Source files outside the result that changed while it ran are
named, and the next request brings them in. Rejecting returns the workspace
to its base.

## Lifetime

The agent keeps its conversation across requests, so continuing builds on
pending changes. Closing a session removes its transcript and record, after
a second confirmation when changes are pending: a workspace and its
unapplied changes go with it, while a session in the source leaves its
changes in the operator's files, where Tesota can no longer revert them, and
releases the trees it pinned. The WSL sandbox's state for a session in the
source, its `node_modules` included, belongs to the source and stays for the
next session. `tesota prune` lists each workspace with what it holds on disk
(`measureWorkspaces` in `src/workspace-prune.ts`), and those no session uses
and that hold no unapplied changes, and `tesota prune --force` removes them, with
every record of a session in the source that no saved session uses, such as
one a crash left, whose trees it releases while its changes stay in the
files, and every shadow repository whose source no longer exists and that
nothing kept needs. Applications and reverts from different sessions
are serialized.

## Why

- **The source by default:** a workspace per session made each session a
  small cloud environment: a clone, a sandbox of its own and its own
  dependencies. On Tesota's repository in the WSL sandbox, a session that only
  answered a greeting kept a 3.5 MB clone and a 900 MB `node_modules`, and
  four such sessions held 3.6 GB (2026-09-29). Local harnesses work in the
  operator's directory:

  | Harness | Where the agent works | How work is reviewed and undone |
  | --- | --- | --- |
  | Claude Code | the operator's directory | checkpoints of what its edit tools change, `/rewind`; commands' changes are not tracked; a Git worktree only with `--worktree` |
  | Codex CLI | the operator's directory, writable in its sandbox | the operator's own Git; its ghost snapshots for undo were removed in April 2026 |
  | Gemini CLI | the operator's directory | a shadow Git repository whose work tree is the project, for a repository or a plain directory alike; `/restore`; off by default |
  | OpenCode | the operator's directory | a shadow Git repository in its data folder whose work tree is the project; revert per step; none outside a Git repository |
  | Cursor | the operator's directory | the agent's edits shown in place to keep or undo |

  Only cloud agents give each task an environment: Codex cloud runs setup
  once and resumes a cached container for up to 12 hours.
- **The promise it moves:** from "reviewed before the operator applies or
  rejects it" to "reviewed before the operator keeps or reverts it". The
  operator decided this on 2026-09-29: unreviewed work is in the source between
  the turn and the decision, and an isolated workspace keeps the
  earlier promise, by default for folders.
- **What stays distinct:** the identity leads with review bound to each turn's
  exact content and a revert that never overwrites the operator's later
  edits ([overview](overview.md#name-and-identity)). Claude Code's rewind
  and OpenCode's revert write earlier content over whatever a file holds.
- **Commands rather than a prompt:** no in-place harness holds the session
  for a decision after every turn; an undecided turn is not acceptance, and
  only `/keep` records it.
- **A clone rather than a Git worktree for isolation:** the agent and its
  commands cannot touch the operator's working tree, index, hooks or remotes,
  and a sandbox can mount the workspace alone.
- **Whole-source admission for an application, and nothing ever replaced by
  accident for either direction:** what is applied is exactly what was
  checked; the operator's own edits are never overwritten, even one made
  during an application or after a turn; and a partial effect is undone or
  recorded as recovery required, never silent.

## Planned

Working in the source is built; what only the old default path used is
gone, since isolated workspaces keep the rest. Real use comes next.

Decided, from what is built and the harnesses above:

- **What isolation costs is measured, not estimated.** `tesota prune` lists
  each workspace with what it holds on the operator's computer and what the
  WSL sandbox keeps for it, its `node_modules` usually most of it; a
  provider that cannot say is left out rather than counted as nothing.
  Tesota states no estimate before creating one, since no harness does and
  the only honest figure would be a previous install it does not record.

- **Dependencies install as the session opens.** For a session in the
  source, the WSL sandbox's state, its `node_modules` included, belongs to
  the source, and the setup fingerprint skips setup when nothing changed, so
  only a repository's first session, or one after its lockfile changes, pays
  for it.
- **No `node_modules` shared across sessions.** Only one session works in the
  source, so a shared `node_modules` would be mounted into isolated clones,
  where one session's install would change the others' and a clone whose
  lockfile differs would get the wrong packages. No harness shares one: t3code
  runs a project's setup script per checkout and Claude Code copies the
  ignored files `.worktreeinclude` names into a worktree. The repository's
  package cache, already shared by its sessions, makes an isolated session's
  install mostly a copy.

Waiting for real use:

- **A base checkout outside the WSL sandbox.** A failing check run on the
  operator's computer or in Docker Sandboxes reports its base as unknown,
  since the WSL sandbox cannot mount that checkout there and the checkout has
  no dependencies. Preparing one with the repository's setup, or with a list
  of ignored files to copy as `.worktreeinclude` names, is built only if real
  use shows such failures often enough to matter.

Sources: [Claude Code checkpointing](https://code.claude.com/docs/en/checkpointing),
[Claude Code worktrees](https://code.claude.com/docs/en/worktrees),
[Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment),
[Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing),
[Cursor Agent Review](https://cursor.com/docs/agent/agent-review),
Gemini CLI's `packages/core/src/services/gitService.ts` and
`sandboxManager.ts`, OpenCode's `packages/opencode/src/snapshot/index.ts`,
Codex's `Remove ghost snapshots` (#19481) and Hermes Agent's
`tools/checkpoint_manager.py`.
