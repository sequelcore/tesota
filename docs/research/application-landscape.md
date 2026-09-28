# Application landscape (September 2026)

How coding agents put their work into the person's own files, what goes
wrong when they do, and what people ask for. It informs the roadmap's "Safer
application" item, rebuilt from `feat/evidence-attribution`, and proposes a
model for it. Researched on 2026-09-28 from vendor documentation, source code
and issue trackers. Pages marked *(summary)* were reached only through search
results or a summarizer, because the proxy blocked them or the page was not
read in full. Product behavior changes quickly; recheck a claim before relying
on it.

## What each system does

Most harnesses edit the person's files in place and offer an undo afterwards.
Only the systems that work in a separate copy, as Tesota does, have a distinct
step that brings the work back, and that step is where the precondition and
recovery questions arise.

| System | Where the agent writes | Bringing work back | Protecting the person's edits | Undo |
| --- | --- | --- | --- | --- |
| Claude Code (Anthropic) | The person's files | Not needed | The Edit tool refuses a file "modified since read, either by the user or by a linter" *(summary; issues #3513, #48390, #28383)* | `/rewind` restores snapshots of files edited through Claude's file tools, for the 100 most recent checkpoints, kept about 30 days. Changes made by Bash, most subagents, and hard-linked or symlinked paths are not restored. Manual edits and other sessions are "normally not captured". "Not a replacement for version control" |
| Codex CLI and cloud (OpenAI) | Local files, or a cloud container | `codex apply` runs `git apply --3way` on the local tree, and reports applied, skipped and conflicted paths (`codex-rs/git-utils/src/apply.rs`, `codex-rs/chatgpt/src/apply_command.rs`) | No dirty-tree check before applying and no copy of the originals. With `--3way`, a conflict leaves conflict markers in the person's files | Undo reverses the recorded diff with `git apply -R --3way` *(summary)*. CLI undo was removed and people asked for it back (issue #16784, closed as a duplicate of #9203) |
| Gemini CLI (Google) | The person's files | Not needed | None found | Checkpointing is off by default. When enabled, each approved file-changing tool first commits the whole project to a shadow repository in `~/.gemini/history/<project_hash>`. `/restore` reverts all files and the conversation |
| Cursor | The person's files, or a Git worktree for parallel agents | Apply merges the worktree's branch into the working branch, file by file if the person chooses *(summary; the docs host was blocked)* | Conflicts appear at merge time *(summary)* | Checkpoints. The forum reports that agent edits applied with Keep/Apply create no editor Local History entry *(summary; forum thread 160159)* |
| Cline | The person's files | Not needed | None found | A shadow Git repository commits after every tool use, untracked files included. Restore uses `git stash`, `git reset --hard` and `git clean -fd` |
| OpenCode | The person's files | Not needed | None found | A Git snapshot before and after each model step, with `/undo` and `/redo` *(summary)*. Outside a Git repository the snapshots are silently disabled (issue #38672) |
| Aider | The person's files | Not needed | Before editing a file with uncommitted changes, Aider commits those changes first, "so you never lose your work" *(summary; the docs host was blocked)* | Every change is a Git commit, and `/undo` reverts the last one |
| Jujutsu (not an agent) | Its working copy | Not applicable | Snapshots the working copy before every command | Every operation is recorded in the operation log and can be undone (`jj undo`, `jj op revert`) *(summary)* |

## Incidents and complaints

- **Gemini CLI replaced a person's files one by one** (July 2025; AI Incident
  Database 1178, issue #4586). A `mkdir` failed without being noticed, and
  each Windows `move` into the missing folder became a rename onto the same
  name, overwriting the file moved before it. Only the last file was left.
  The reporter's own analysis: nothing checked after writing that the write
  had done what was assumed. Two lessons follow. Installing a file must fail
  rather than replace one, and the result must be read back before it is
  called done.
- **Cline's restore deleted files the person meant to keep** (issue #14367).
  The restore stash left ignored files on disk. `git reset --hard` then put
  back an older `.gitignore`, so `git clean -fd` saw those files as untracked
  and deleted them permanently. On Windows they went "with zero Recycle Bin /
  Trash fallback". The fixes proposed were to check before acting, to delete
  recoverably, and to remove only the files known to have been created. The
  undo path is itself a writer, and needs the same guards as the forward one.
- **A detected stale write went ahead anyway** (Claude Code issue #27941).
  Claude Code compared the config file's `mtime` and size, noticed the person
  had edited it, logged telemetry, and overwrote it regardless. A check that
  does not stop the write protects nothing.
- **Strict staleness checks become friction** (Claude Code issues #3513,
  #48390, #28383 and #33856, *summary*). The Edit tool's "modified since read"
  error fired after Claude's own earlier edits and after formatters, and in
  one report it would not clear even though the file was unchanged. People
  asked for a re-read, a diff-aware edit, or a warning in place of the block.
  A strict rule stays usable only if it never fires on the harness's own
  writes, explains what changed, and offers a cheap way forward.
- **Undo is expected, and needed most without Git.** Codex users asked for
  undo back (#16784). OpenCode's `/undo` reported success on a project without
  Git while restoring nothing (#38672). Its reporter noted that projects
  without Git need undo more, because they have no other way back. That is
  exactly the folder workspace of decision 032 and its first real user.
- **Agent edits missing from the editor's own history** (Cursor forum,
  *summary*). The person could not see or undo an applied change with their
  usual tools.

## What the platforms allow

- **Installing without replacing.** POSIX `link(2)` fails with `EEXIST` if
  the name exists, and Windows `CreateHardLinkW` fails the same way. Node's
  `fs.link` wraps both. Linking a finished temporary file to the target name
  and then removing the temporary name installs the content atomically,
  without ever replacing anything. `renameat2(RENAME_NOREPLACE)` on Linux and
  `renameatx_np(RENAME_EXCL)` on macOS do the same in one step, and Windows
  `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` refuses an existing
  target. Node exposes none of these directly. File systems without hard
  links, such as FAT32 and exFAT drives, need a fallback: `open` with
  `O_EXCL` (`"wx"`) directly at the target, which never replaces anything but
  is not atomic for content.
- **Checking and then renaming is a race.** Whatever lies between the check
  and `rename(2)` is replaced without trace. Tesota's current application
  (`src/workspace-apply.ts`) has this gap for added files (checked absent,
  later renamed over) and for changed files (checked equal, later renamed
  over).
- **Moving the original aside closes the gap.** Renaming the target to a
  holding name in the same directory is atomic, and keeps whatever was there,
  including an edit made a moment before. Tesota can then compare the held
  bytes with the base. If they differ, the operator's edit was never
  destroyed: it is put back and application stops. While the target name is
  briefly absent, an editor may recreate the file. The no-replace install
  then fails, and both versions are kept.
- **Windows refuses to move a file that another program holds open** without
  shared delete access. Office documents open for editing are the common case
  (`EBUSY` or `EPERM`). This happens before that path is changed, so it is a
  clean stop rather than a partial result.
- **Durability** needs `fsync` on the file, and on POSIX also on the
  directory that holds the new name. Windows has no directory `fsync`. A
  journal entry is trustworthy only after its own `fsync`.

## Patterns

1. **Keep the person's bytes before touching them.** Aider commits dirty
   files first. Gemini CLI, Cline, OpenCode and Jujutsu snapshot everything
   first. Claude Code keeps per-file snapshots. Only Codex's apply keeps
   nothing.
2. **Snapshots are kept by the harness, outside the project, for a
   limited time**: Claude Code about 30 days, Gemini CLI and Cline in shadow
   repositories.
3. **Everyone who works in a copy moves conflicts to the moment of bringing
   work back.** Codex resolves them with a three-way merge that can leave
   markers in the person's files. Cursor resolves them with a Git merge.
   Tesota refuses instead, and brings the newer source into its copy first,
   so checks and review see the combination.
4. **Nobody found states a whole-tree precondition.** The checks found are
   per file: Claude Code's read-before-edit and Tesota's own. Codex has none.
5. **Undo is where data is lost** (Cline #14367, OpenCode #38672). Restoring
   must be guarded, targeted and honest about what it did.
6. **Silent failure of the safety net is the common defect**: the Claude Code
   stale write, OpenCode without Git, Gemini CLI's checkpointing silently
   failing outside a Git repository (issue #4115, *summary*).

## A model for Tesota (proposed)

This is a proposal to discuss, not a decision. Once agreed, it becomes a
decision record and replaces "Applying and rejecting" in the
[workspace design](../design/workspace.md#applying-and-rejecting).

### Terms

- **Source**: the operator's repository or folder, as `SourceSnapshot.capture()`
  sees it: tracked and non-ignored files, as one Git tree.
- **B**: the source tree the workspace last took (`recorded()`), which the
  base reflects.
- **C**: the reviewed candidate tree. **Δ** is the list of paths that differ
  between B and C, each an add, a modify or a delete, with its before and
  after content hash.
- **Hold**: a file's original moved aside to `.tesota-<id>.hold` in its own
  directory, then copied into the recovery store.
- **Recovery store**: `applications/<id>/` in the workspace's state directory,
  outside the source. It holds each original, a manifest and the journal.

### Invariants

- **I1. Nothing the operator had is lost.** From the moment application
  starts, each path in Δ has its pre-application bytes either at the path or
  in a hold or the recovery store. A copy is written and synced before the
  path it protects changes.
- **I2. Tesota replaces only the base content.** A path is changed only
  after its current bytes, read from the hold, are shown to equal the base.
  Anything else goes back where it was.
- **I3. Only what was reviewed and checked is applied.** Application starts
  only when the whole source still equals B. The result is then exactly C,
  the tree the evidence refers to, and never C combined with operator edits
  nobody checked.
- **I4. "Applied" is claimed only after reading back.** Every path in Δ is
  read back and matches its after hash.
- **I5. No partial result is silent.** Every outcome is one of applied, not
  applied, or recovery required. The state is synced to the journal before it
  is shown, and it survives a crash.
- **I6. Undo obeys I1 and I2.** Restoring puts an original back only where
  the path still holds exactly what Tesota wrote.

### Admission

A pure decision, to be specified with LemmaScript and proved like the rules in
`src/verification/`:

| Unfinished application for this source | Review still current (workspace tree = C, base = B) | Source equals B | Recovery store ready | Decision |
| --- | --- | --- | --- | --- |
| yes | any | any | any | `recover`: finish or undo that one first |
| no | no | any | any | `stale_review`: review again |
| no | yes | no | any | `refresh`: take the source's changes, then check and review again |
| no | yes | yes | no | `not_ready`: nothing written; say why |
| no | yes | yes | yes | `apply` |

`refresh` is not a conflict. It runs `workspace.update()`, and new evidence is
needed because the tree changed. When none of the changed source paths are in
Δ, the rebase is trivial, but decision 039 still requires checking again on
the new base. The "unfinished application" marker belongs to the source, not
the session, so a second session on the same source is also stopped after a
crash. Today applications are serialized only within one process.

### Phases

1. **Prepare**, with nothing changed in the source yet. Write each after
   content to a temporary file beside its target and sync it. Record the
   manifest (path, action, before hash, after hash, mode, directories to
   create) and a journal entry `prepared`, and sync both. Any failure here
   ends as **not applied**, and the temporary files are removed.
2. **Commit**, path by path. Each step is journaled as intended before it
   runs and as done after.
   - *Add*: link the temporary file to the target. `EEXIST` means the name
     appeared since the check, which is a stop.
   - *Modify*: rename the target to its hold, then compare the hold with the
     before hash. If it differs, rename it back and stop. Otherwise link the
     new content in; `EEXIST` means the file was recreated, which is a stop.
     Copy the hold to the recovery store.
   - *Delete*: rename to the hold, compare, and copy to the recovery store,
     as for a modify.
   - `EBUSY` or `EPERM` on the first rename (a file open in Office on
     Windows) is a stop for that path.
3. **Verify.** Read back every path in Δ and compare it with its after hash
   (I4). Then capture the source. If the source equals C, the application is
   exact. If paths outside Δ also changed, it is still applied, but the
   operator is told that the source changed during application, and the next
   request takes those changes in.
4. **Settle.** Journal `applied`, move the workspace base to C, record the
   source as C, and remove the holds. The copies in the recovery store stay
   for undo, for a retention period still to be decided.

**On a stop or an error after the first change**, Tesota rolls back at once.
It walks the done steps in reverse, and each restore obeys I6. If every
restore succeeds and reads back, the outcome is **not applied (rolled
back)**. If any restore does not, the outcome is **recovery required**.

**On a crash** (the process killed, the machine off), the journal holds
`prepared` or intended steps with no terminal entry. The next `tesota` start,
or the next application to that source, reports **recovery required**.

### Recovery required

Tesota classifies each path in Δ by what it holds now:

| Holds | Meaning |
| --- | --- |
| before hash | untouched |
| after hash | Tesota's write is in place |
| absent, hold present | moved aside, not yet replaced |
| anything else | changed by someone else since |

It then offers three actions:

- **Undo**: restore every original under I6.
- **Finish**: complete the remaining steps under I2.
- **Resolved by hand**: the operator states that the source is as they want
  it. This is recorded as the operator's acceptance, never as check evidence
  (AGENTS.md).

Paths "changed by someone else" are listed and never touched. The session
stays blocked, as today, until one action ends the application.

### Undo after success

The copies kept in the recovery store make an undo of the last applied result
possible under I6. That is the feature Codex users asked back for and OpenCode
lacks outside Git. It is a separate capability to add later. This model only
keeps what it will need.

### Decisions to prove

Each is a pure function in `src/verification/` with `//@` specifications:

- `applicationAdmission`: the table above. `apply` only when every condition
  holds, and `recover` takes precedence over everything else.
- `pathStep(action, observed)`: install, already done, or stop. It never
  replaces or removes bytes whose hash is neither the before nor the after
  hash (I2, I6).
- `applicationOutcome(steps)`: `applied` only if every path is done and read
  back; `not_applied` only if no path is left changed; otherwise
  `recovery_required` (I4, I5).

### Tests the model calls for

The tests inject a fault and a racing write at each point: before and after
each temporary write, link, rename to the hold, comparison, copy to the
recovery store and journal sync. They also cover:

- an editor recreating a file in the window where it is absent;
- a file open with no shared delete access on Windows;
- a volume without hard links;
- a crash between any two journal entries;
- an operator edit to a file outside Δ before and during application.

Each must end in one of the three outcomes with I1 to I6 holding. This follows
the fault-injection approach of decision 038.

### Open questions

1. **Strict whole-tree admission (I3) or per-file admission as today.** Strict
   is the only rule that keeps "applied equals checked". Its cost is a
   refresh, followed by new checks, whenever the operator edits anything.
   Claude Code's experience shows the friction must be answered with a clear
   message and a one-step way forward.
2. **Automatic rollback on a stop, or recovery required straight away.**
   Rollback under I6 keeps the source whole more often. The roadmap names
   only the marking.
3. **Retention of originals**: per application, by count, or by days, as
   Claude Code's 30.
4. **Ignored files** (`.env`, `node_modules`) are outside B and C, so edits
   to them neither block nor are protected. That matches today's evidence
   boundary, but should be stated to the operator.
5. **Metadata beyond the executable bit**: Windows ACLs, extended attributes
   and timestamps are not carried over. Moving the original aside keeps its
   inode for the hold, but the new file gets default permissions. Folders
   synced by OneDrive may need a live check.

## Sources

- Claude Code, "Checkpointing": https://code.claude.com/docs/en/checkpointing
- Claude Code issues #27941, #3513, #48390, #28383, #33856:
  https://github.com/anthropics/claude-code/issues
- Codex source, `codex-rs/git-utils/src/apply.rs` and
  `codex-rs/chatgpt/src/apply_command.rs`: https://github.com/openai/codex
- Codex issue #16784: https://github.com/openai/codex/issues/16784
- Codex cloud task application *(summary)*:
  https://codex.danielvaughan.com/2026/04/08/codex-cloud-task-application/
- Gemini CLI, checkpointing:
  https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/checkpointing.md
- Gemini CLI issues #4586 and #4115, and AI Incident Database 1178:
  https://incidentdatabase.ai/cite/1178/
- Cline, checkpoints: https://docs.cline.bot/core-workflows/checkpoints, and
  issue #14367: https://github.com/cline/cline/issues/14367
- OpenCode, snapshots: https://opencode.ai/v2/docs/snapshots/, and issue
  #38672: https://github.com/anomalyco/opencode/issues/38672
- Aider, Git integration *(summary)*: https://aider.chat/docs/git.html
- Cursor, worktrees *(summary)*: https://cursor.com/docs/configuration/worktrees,
  and forum thread 160159:
  https://forum.cursor.com/t/agent-file-edits-do-not-create-a-timeline-local-history-entry/160159
- Jujutsu, operation log *(summary)*: https://docs.jj-vcs.dev/latest/operation-log/
- `rename(2)` and `renameat2(2)`: https://man7.org/linux/man-pages/man2/rename.2.html
