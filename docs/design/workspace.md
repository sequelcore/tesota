# Workspace

The agent never works in the operator's repository. Each shell session owns a
**workspace**: an independent clone under `~/.tesota/workspaces/`, whose
changes reach the repository only when the operator applies a reviewed result.

## Creating a workspace

A workspace is a clone of the source repository's committed `HEAD`, without
its remotes, hooks or configuration. The source's uncommitted, non-ignored
changes are captured through a private index and object directory kept in the
workspace, so nothing is written to the source, and added as one commit. That
commit is the **base**: later diffs show only the agent's work. Ignored files,
such as `.env` or `node_modules`, are not copied.

Line endings follow the operator's `core.autocrlf` setting. Symbolic links are
checked out as plain files holding the link text (`core.symlinks=false`) and
submodules stay uninitialized; application refuses changes to either.

## A folder as the source

Decision 032. A directory that is not in a Git repository is worked on as a
**folder**, after the person agrees once: `tesota` says how many files it
holds and how large they are, and that nothing in it changes until a
reviewed result is applied. Tesota then keeps a private Git view of the
folder in `~/.tesota/folders/`, named by the folder's path, never inside the
folder: a bare repository whose work tree is the folder, the pattern people
use to version the dotfiles in their home directory. Its one commit holds
the folder as Tesota first found it, and every later edit, the person's or
an applied result, is to it what uncommitted changes are to a repository,
so creating the copy, keeping it current and applying work the same way
(`src/folder-source.ts`). The lock files Office and LibreOffice keep while a
document is open, and the files Windows and macOS leave in folders, are not
copied.

The home directory and a drive or file system root are refused as folders:
they hold far more than one piece of work, credentials included. For the
same reason a directory is worked on as a repository only when its
repository's top level is neither of them: a home directory kept in Git, as
dotfiles often are, would otherwise make any folder inside it stand for the
whole home. File contents up to 512 MB are read when the source changes, so
a scanned PDF or a large spreadsheet can be brought into the copy.

## Keeping it current

Before each operator request, never before a correction round, which keeps
the base its candidate was checked on ([assurance](assurance.md#correction)),
the workspace takes the source's newer state the way Git
rebases: the captured source becomes the new base, and pending work is carried
onto it with a three-way cherry-pick. If pending work conflicts with the newer
source, nothing changes and the operator is told which files; the agent is
told which files changed. The private index keeps Git's stat cache, so a
check that finds nothing new is cheap.

## Snapshots and the request record

A **snapshot** stages all work and records the changed paths, the diff and the
Git tree id. Checks, review and application all refer to that tree, so
evidence is bound to exact content: if the tree changes, the evidence no
longer applies.

The operator's requests behind the pending changes are recorded verbatim in
`requests.jsonl` beside the checkout, where the agent's tools cannot reach
them. The record starts over whenever nothing is pending. Reviewers see these
requests, never the agent's own account of them.

## Applying and rejecting

Application writes exactly the reviewed tree. For each changed file the source
must still hold the base content (a CRLF checkout of that content counts as
unchanged and keeps its line endings); an added file must not exist yet. If
any file conflicts, nothing is written. Writes are journaled in the
workspace's `applications.jsonl`; a failure after the first write is reported
as uncertain and blocks the session, keeping its workspace as evidence. After
a successful application, the workspace records the applied tree as its new
base. Rejecting returns the workspace to its base.

## Lifetime

The agent keeps its conversation across requests, so "keep working" builds on
pending changes. Closing a session removes its workspace, transcript and
record, after a second confirmation when changes are unapplied. `tesota prune`
lists other workspaces no session uses and that hold no unapplied changes, and
`tesota prune --force` removes them. Applications from different sessions are
serialized.

## Why

- **A clone rather than a Git worktree or the operator's checkout:** the agent
  and its commands cannot touch the operator's working tree, index, hooks or
  remotes, and a sandbox can mount the workspace alone.
- **Uncommitted changes included:** the agent works on what the operator
  sees, not on a stale commit, without Tesota writing to the source.
- **Conflict-checked, all-or-nothing application:** the operator's own edits
  are never overwritten, and a partial application is never silent.
