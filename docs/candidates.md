# Candidate checkouts

A candidate checkout is a separate copy of a committed repository revision.
It is preparation for a real task; it does not yet grant model editing,
execution or promotion permissions.

From the source repository, build Tesota and create a candidate:

```sh
bun run build
bun start candidate create
```

The command returns JSON containing the candidate directory, its checkout path,
the full baseline commit and whether the source had uncommitted changes.
Candidates live under the current user's `.tesota/candidates/`, outside the
source repository and outside Kiln's private namespace.

To inspect one, use the directory returned by creation:

```sh
bun start candidate inspect <candidate-id|candidate-directory>
```

You normally do not need to open the candidate folder. List candidates by their
stable ID and lifecycle status:

```sh
bun start candidate list
```

The statuses are `active` (created but no attempt evidence), `awaiting-review`
(an attempt or diff is present), `accepted`, `rejected`, `abandoned`, `failed`, or
`invalid`.
They are derived from the existing checkout and decision records; the listing is
an observation, not acceptance authority. Inspection, review, decision and
promotion commands accept either the displayed ID or its directory.

Creation takes the source repository from the current directory. It accepts no
destination, revision, remote URL or Git flags from CLI arguments. Extra
arguments exit 2. Creation or inspection failures exit 1. A successful inspection
exits 0 even when it reports changed files; it does not mean a task passed.

## Baseline and separation

Creation records committed `HEAD`, then makes an independent, shallow local clone
with its own object database and detached checkout. It uses no object alternates,
shared worktree metadata or hard-link clone optimization, and removes the clone's
remote. A source that is itself a Git worktree is supported.

Staged changes, unstaged changes, untracked files and ignored operator state are
not copied into the candidate. `sourceDirty` reports staged, unstaged or untracked
changes observed before cloning; ignored files do not set it. The source's
working files, index, configuration, refs and worktree registry are preserved.
The recorded commit is a baseline identity, not a claim that it was verified or
accepted. A moving source may cause creation to fail rather than silently choose
a different baseline.

Only regular tracked files are admitted in this increment. Symbolic links and
submodules are rejected before checkout. Candidate storage cannot overlap the
source; redirected directory paths are rejected. Source and destination are
expected to remain under trusted, single-writer control during creation.

The Git subprocess receives fixed argument arrays and a restricted environment.
System/global Git configuration and ambient Git directory overrides are
excluded; filesystem-monitor hooks and checkout hooks are disabled. Checkout
does not inherit global filter definitions. Only local file transport is
enabled, and submodule recursion is disabled. Dependencies are not installed and
repository scripts are not run.

## Inspection and incomplete work

Each candidate directory contains `checkout.json`, an empty Git template
directory, and `repo/`. The record format is `tesota-candidate-checkout` version 1.
Its schema owns the allowed fields and rejects unknown fields, unsupported
versions, malformed revisions and invalid state. Reads are capped at 16 KiB.

Creation records `preparing` before cloning and `ready` only after validating
the baseline, clean checkout and independent Git storage. On failure it attempts
to record `failed`. The directory is retained, and the error identifies it.
A crash can leave `preparing` or a temporary record; neither counts as ready.
There is no automatic resume, removal or overwrite of an earlier candidate.

Terminal checkouts are cleaned separately from their evidence. After the
retention period, `candidate clean` removes only the `repo/` and template
directories for old rejected or failed candidates. It preserves `checkout.json`,
diffs, attempts, decisions and promotion journals. Active, awaiting-review and
accepted candidates are never removed by this command. The default retention is
30 days; cleanup never runs as a side effect of creation, review or checking.

If a candidate is no longer relevant, explicitly mark it first:

```sh
bun start candidate abandon <candidate-id>
```

Abandonment is a local operator assertion. It does not grant acceptance or
promotion authority. Abandoned candidates become eligible for the same
evidence-preserving cleanup as rejected candidates.

Inspection requires a ready record and checks the checkout's Git directory,
common directory, remotes and object-sharing metadata. It reports the current
HEAD, whether it differs from the baseline, and file changes against that
baseline. Tracked changes use Git status letters; `?` identifies untracked files
and `!` identifies ignored paths or directories. These observations do not enforce
a task's allowed-file list. The source may be unavailable during inspection.

Stored metadata has `recorded_untrusted` provenance. Valid structure and a clean
checkout do not establish issuance authority, verification or human acceptance.
The record contains local paths and belongs in operator state, not tracked
project documentation.

## Limits and next increment

Each Git command has a 60-second timeout and an 8 MiB captured-output bound.
There is no aggregate creation deadline or disk quota in this increment. Cleanup
is explicit and currently targets only old rejected or failed checkouts.
Git is a trusted installed executable; a process timeout is not proof that every
Git descendant terminated. Failed attempts remain available for inspection.

An independent clone reduces accidental coupling. It is not an operating-system
sandbox, protection against a hostile same-user process, or permission to run
candidate code. It is shallow and does not provide the full source history.
Record replacement is not a power-loss durability guarantee.

The first [scoped task](tasks.md) defines allowed files, replacement limits and a
fixed documentation check. Its live command creates a new candidate for each
attempt. See the [roadmap](roadmap.md). The earlier
[one-file correction exercise](../experiments/codex/candidate.md) remains a
separate, deliberately narrow experiment.
