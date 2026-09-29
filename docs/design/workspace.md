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

A directory that is not in a Git repository is worked on as a
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
- **Whole-source admission, a copy first, and nothing ever replaced by
  accident:** what is applied is exactly what was checked; the operator's own
  edits are never overwritten, even one made during application; and a
  partial effect is undone or recorded as recovery required, never silent.
