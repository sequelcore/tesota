# Scoped candidate task

The first repository task is `pi-decision-status`: correct the outdated status
paragraph in `docs/decisions/002-use-pi.md`. Its existing text says the live
integrations remain open, while retained evidence records successful bounded
experiments. The correction must preserve the rest of the decision and must not
claim a complete repository task cycle.

The first code task is `pi-result-consistency`: strengthen the pure
`piTaskPasses` predicate so inconsistent session evidence cannot be accepted.
Its candidate may change only the body of `src/integrations/pi-task.ts`; the
behavior oracle runs the candidate function in a pinned Node container with no
network or host mounts. The checker covers valid completion, correction after an
intermediate failure, bounds, issued provenance, task and baseline consistency,
changed hashes and current-check matching. It does not run the candidate
repository or expose source credentials.

Tesota implements preparation, operation admission, deterministic documentation
and code checks, and bounded live model attempts. A separate explicit command can promote
the accepted paragraph change to the source working tree.

## Run the task

After the [one-time login](authentication.md), build the current executor and run:

```sh
bun run build
bun start task run
```

This Windows command reuses saved authentication and creates a fresh independent
candidate from committed HEAD. Uncommitted source changes are excluded. It issues
a new in-memory task handle; it does not reopen a previously prepared task.
The model can use only the task's read, replace and check operations. The adapter
allows at most eight model invocations, thirteen tool calls and 4,096 output tokens
per invocation, with no retries and a two-minute session deadline. These are
admitted SDK calls, not independently counted HTTP requests.

The printed candidate directory retains `attempt.jsonl`, `candidate.diff`, the
task plan and the checkout. The attempt records executor file hashes, limits,
observed calls, issued checks and a final read-only applicability check. It does
not retain credentials, raw model responses or provider error text. The diff
contains model-authored document content and must be treated as untrusted.

Exit 0 requires model completion, an initial failed check, an edit, a passing
final check supplied to the model, and a matching current check with a saved diff.
Other attempt outcomes exit 1; unsupported platforms or arguments exit 2. A model
claiming success cannot satisfy these conditions. Human acceptance remains separate.

Interruption closes task authority and requests cancellation. An unresponsive
session gets a two-second settlement window; missing settlement is reported as
`unsettled`. A six-minute outer watchdog requests process exit if the attempt
has not returned. Timers cannot preempt synchronous Git calls; each Git command
has its own 60-second timeout, so filesystem or Git stalls can delay timer handling.
A start record without a finish record is incomplete. A finish record reports the
local runner's outcome and may still contain an unsettled session; it does not
prove server-side cancellation. No automatic retry, resume or promotion occurs.

## Review and decide

These offline commands review current candidate bytes and record a separate local
operator decision:

```sh
bun start task review <candidate-directory>
bun start task decide <candidate-directory> accept <review-sha256>
bun start task decide <candidate-directory> reject <review-sha256>
```

Review regenerates the diff and runs the documentation check before and after
capturing it. Its fingerprint binds the canonical candidate directory, baseline,
current file hash, check status and diff. Output JSON-escapes the diff instead of
printing its untrusted bytes directly to the terminal. Review does not trust
the retained `candidate.diff` or interpret `attempt.jsonl` as proof of completion;
historical model activity remains `not_evaluated` in this current-state review.
The separate attempt record remains available for historical inspection.

Use the returned `reviewSha256` for an explicit decision. Acceptance requires a
passing current check and the same fingerprint. Rejection can record a decision
on a failed check. Either decision is exclusively saved to `decision.json`; an
existing decision is never overwritten. Later reviews mark the record stale when
the fingerprint changes. Out-of-scope changes or malformed records make review
unavailable. A late mutation after saving may leave a recorded decision that is
stale or cannot currently be evaluated; the command does not roll it back.

These are local operator assertions, not authenticated proof of a human identity
or of reading the diff. Recovered records have `recorded_untrusted` provenance.
The model tool set does not include review decisions. Decisions do not change the
check's `taskAcceptance`, authorize execution, modify the source repository or
promote the candidate. Revision/revocation and authenticated approval are not
implemented. The trusted single-writer limitation still applies.

Review exits 0 when it can report the current state, including a failed check or
stale decision. A decision exits 0 when recorded and currently applicable, 1 if
the post-write review finds it stale, and 2 for invalid or unavailable operations.
An error after persistence does not imply that no decision file was created.

## Promote an accepted change

From the original source repository root, use the accepted review fingerprint:

```sh
bun start task promote <candidate-directory> <review-sha256>
```

This explicit invocation authorizes one source-file replacement. The saved
acceptance is a required local assertion, not independent write authority. No
model tool can invoke promotion. Tesota rechecks the accepted fingerprint, current
task check and source identity. The target's committed blob and mode must match
the candidate baseline, its index entry must match HEAD, and its working bytes
must match the baseline exactly. Later commits affecting other files are allowed;
staged or unstaged target changes are rejected. Unrelated edits remain untouched.

Only the task-owned decision-document path can be replaced. Regular single-link
files and unredirected paths are required. The replacement is captured and hashed,
written to an exclusive temporary file beside the source target, then rechecked
before rename. Source permissions are carried into the temporary file. The
command does not stage files, commit, move refs or execute candidate code.

An exclusive `promotion.jsonl` beside the candidate records the source, revision,
review fingerprint and before/after hashes before the write. A verified write
records `applied`; a caught failure records `not_applied` or `applied_unconfirmed`
when possible. A start without a terminal record is incomplete. Exit 0 reports a
verified replacement; exit 2 requires inspecting both source and journal because
failure after the rename can still leave the change applied. An existing journal
blocks another attempt. There is no automatic rollback, journal deletion or retry.

This remains a trusted single-writer operation, not a filesystem transaction or
authenticated approval system. Other processes can race the final observation
and rename. Interrupted writes may leave a temporary file or incomplete journal;
power-loss durability and recovery are not established. Promotion of multiple
files, conflict resolution and stable executable version switching remain future
work.

## Prepare and inspect

Create an [independent candidate](candidates.md), then use its returned directory:

```sh
bun start task prepare <candidate-directory>
bun start task check <candidate-directory>
```

Preparation requires an unchanged candidate and an applicable baseline document.
It returns the objective, permitted files, required replacement paragraph and
limits, and exclusively saves `task.json` beside the checkout. An existing plan
is never overwritten. The initial check should fail because the stale paragraph
has not been corrected yet.

`task check` exits 0 for the exact correction and 1 for an unmet task assertion.
Invalid arguments, unavailable state or scope violations exit 2. The check
reports its observed source SHA-256 and baseline. Saved plans are strictly parsed
and compared with the baseline files; their provenance remains
`recorded_untrusted`. Editing JSON cannot expand the application's allowed scope.

## Enforced scope

The application-owned contract in `src/candidate-task.ts` permits:

- Reading the Pi decision, roadmap and Codex experiment history.
- Replacing only `docs/decisions/002-use-pi.md` after an initial check, with the
  current content's SHA-256 supplied by the caller.
- Running the task's fixed documentation check.

There are at most eight reads, two replacements and three checks per active
handle. Each file and replacement is bounded to 64 KiB of valid UTF-8. Unknown
fields, unlisted paths, stale hashes, NUL and invalid Unicode are rejected.
The handle closes on an operation failure; concurrent use is rejected. A model
cannot select executable commands, create files, delete files, change permissions
or edit task metadata through this API.

Before operations, the adapter checks the checkout baseline and detects changes
outside the writable file, including untracked and ignored paths. The read-only
context files must retain their baseline hashes. Writable-file changes must
match the handle's last known content. Redirected paths and hard-linked files
are rejected. Replacement is written to an exclusive temporary file outside the
checkout, rechecked against current state, then renamed into the fixed target.

The deterministic check requires the specified status paragraph and preserves
every other document byte. It accepts neither an unrelated rewrite nor a claim
of general agent-task readiness. This documentation task requires no code
execution or test/build command inside the candidate. Broader tasks will need
their own appropriate checks; an Oxlint pass would not verify these prose claims.

## Authority and limits

`CandidateTask.prepare` creates an in-memory editing handle selected by trusted
application code. The preparation CLI closes that handle after printing the
plan. Loading `task.json` supports read-only checking; it does not recreate the
handle or reset an execution budget. `task run` creates a new candidate and handle
for each explicit invocation instead of interpreting a saved plan as authorization.

These are task-tool boundaries in a trusted single-writer workspace. They do not
sandbox a hostile same-user process, authenticate stored metadata, or guarantee
atomic observation of the entire filesystem. Failed writes may leave local
temporary state; there is no automatic rollback, task resume or automatic promotion.
An earlier check describes its observed bytes, not later edits. Checks always
retain `taskAcceptance: "not_evaluated"`; operator decisions are separate records.
