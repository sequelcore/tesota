# Registered candidate tasks

`src/candidate-task-definition.ts` is the canonical registry for task IDs,
requirements, readable and writable paths, oracle identity, model instructions,
limits and promotion policy. `CandidateTask` enforces the selected definition;
it contains no task-name branches. Persisted plans are evidence, not executable
authority.

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
repository or expose source credentials. A body that is not valid JavaScript is
reported separately from behavioral case failures so Pi can correct the syntax
without changing the oracle.

Tesota implements preparation, operation admission, deterministic documentation
and code checks, and bounded live model attempts. A separate explicit command can
promote an accepted registered or admitted write set to the source working tree.

Proposal-backed documentation work is deliberately separate from this registry.
`proposal-admission.ts` can issue one in-memory grant for a current ready proposal
that writes one existing Markdown file below `docs/`. `CandidateTask` enforces its
proposed read/write paths with the same per-file hashes and budgets, while the
persisted grant remains untrusted evidence. Its application-owned check establishes
only scope integrity and a changed target; it reports that the declarative
repository check did not run and leaves prose correctness to human review. See
[Task proposals](proposals.md) for the full one-shot lifecycle.

The first proposal-backed code task is also separate from model-authored scope.
`src/proposed-code-task.ts` maps only the exact pair
`src/integrations/pi-task.ts` and `tests/pi-task-evidence.test.ts` to the registered
`pi-result-consistency` oracle. Proposed extra reads are attenuated out of the run
grant. The source edit remains limited to `piTaskPasses`; the focused test may only
append to its committed baseline. Its assertions supplement the immutable
container oracle and still require human review. No other TypeScript proposal is
currently executable.

The first formal property is `canAdmitInvocation` in
`src/verification/invocation-admission.ts`. Run `bun run formal:check` to let
LemmaScript generate and verify its Dafny proof. The property is used by the
Pi task, live-probe and verification adapters before admitting model work. A
passing proof records only that this small property holds; it does not certify
the surrounding adapters or grant acceptance authority.

The fourth registered task is `candidate-source-newline`. It deterministically
changes `candidateSatisfiesTask` from disjunction to conjunction in an isolated
checkout, so both valid source forms are rejected. Its predeclared oracle requires
the exact baseline implementation to be restored and emits a specific diagnostic.
Direct task operations and a simulated Pi session completed the failed-check,
edit and passing-check sequence. The first stored-OAuth attempt created candidate
`de392e40-c337-4dc8-8399-73e22e3b8b96`, but the provider returned HTTP 429
before any tool call or edit. A fresh retry against baseline `7ff096c8` created
candidate `02d51cc2-282a-4c1d-9135-d18c5dfbb8fb` and completed with five model
invocations, four tool calls and one edit. Its first issued check failed with the
predeclared diagnostic; its second check and current read-only check passed with
the same verifier identity and corrected source SHA-256. The final diff is empty
because the oracle requires exact restoration of the baseline bytes. No operator
decision or promotion was recorded.

The fifth registered task is `multi-file-task-status`. It expands task status
wording in `README.md` and `docs/identity.md`, then requires both files to match
their exact expected bytes. Its ordered two-file write set
exercises per-file stale-hash admission, aggregate check and review identity, and
guarded multi-file promotion without granting access to other repository paths.

## Run the task

After the [one-time login](authentication.md), build the current executor and run:

```sh
bun run build
bun start task run [task-id]
```

This Windows command reuses saved authentication and creates a fresh independent
candidate from committed HEAD. Uncommitted source changes are excluded. It issues
a new in-memory task handle; it does not reopen a previously prepared task.
The model can use only the task's read, replace and check operations. The adapter
allows at most ten model invocations, thirteen tool calls and 4,096 output tokens
per invocation, with no retries and a three-minute session deadline. These are
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

The registered IDs are `pi-decision-status`, `pi-result-consistency`,
`formal-invocation-admission`, `candidate-source-newline` and
`multi-file-task-status`. Omitting the ID
selects `pi-decision-status`; an unknown ID is rejected before candidate
creation.

To run the formal correction task, use:

```sh
bun start task run formal-invocation-admission
```

This creates a candidate with a deterministic failing implementation of
`canAdmitInvocation`. `tesota_check` runs LemmaScript and Dafny in a temporary
copy, returns the verifier diagnostics to Pi, and requires a later passing check.
The candidate source remains isolated until a separate review and acceptance;
formal evidence does not authorize promotion.

Interruption closes task authority and requests cancellation. An unresponsive
session gets a two-second settlement window; missing settlement is reported as
`unsettled`. A six-minute outer watchdog requests process exit if the attempt
has not returned. Timers cannot preempt synchronous Git calls; each Git command
has its own 60-second timeout, so filesystem or Git stalls can delay timer handling.
A start record without a finish record is incomplete. A finish record reports the
local runner's outcome and may still contain an unsettled session; it does not
prove server-side cancellation. No automatic retry, resume or promotion occurs.

To retry a failed or incomplete registered task explicitly, run:

```sh
bun start task recover <candidate-id|candidate-directory>
```

Recovery accepts only a ready, undecided candidate whose bounded attempt record
is either failed or lacks a complete terminal record. Tesota validates its current
version 3 task plan and scope without rerunning the old oracle, then clones the
predecessor's exact commit into a new independent candidate and starts the same
registered task with fresh authority and limits. The successor attempt binds the
predecessor ID, baseline and prior outcome. It copies no working bytes, checks,
diff, decision or acceptance from the predecessor. Successful, decided, abandoned,
invalid and obsolete-plan candidates are rejected before successor creation.

This is task retry from a known baseline, not continuation of the previous Pi
conversation. Multiple explicit recoveries may create independent successors;
there is no automatic deduplication. Recovery does not settle the old provider
request, repair incomplete promotion journals or grant human acceptance.

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

This explicit invocation authorizes the registered task's complete write set. The saved
acceptance is a required local assertion, not independent write authority. No
model tool can invoke promotion. Tesota rechecks the accepted fingerprint, current
task check and source identity. Every target's committed blob and mode must match
the candidate baseline, its index entry must match HEAD, and its working bytes
must match the baseline exactly. All targets are preflighted before the first
rename. Later commits affecting other files are allowed; staged or unstaged target
changes are rejected. Unrelated edits remain untouched.

Only definitions whose application-owned promotion policy is `allowed` can be
promoted: currently the decision-document task, `pi-result-consistency` and
`multi-file-task-status`.
The formal and candidate-source tasks remain unsupported.
Regular single-link files and unredirected paths are required. The replacement
is captured and hashed, written to an exclusive temporary file beside the source
target, then rechecked before rename. Source permissions are carried into the
temporary file. The command does not stage files, commit, move refs or execute
candidate code.

An exclusive `promotion.jsonl` beside the candidate records the source, revision,
review fingerprint and every before/after hash before the write. A verified write
records `applied`; a caught failure records `not_applied`, `partially_applied` or `applied_unconfirmed`
when possible. A start without a terminal record is incomplete. Exit 0 reports a
verified replacement; exit 2 requires inspecting both source and journal because
failure after the rename can still leave the change applied. An existing journal
blocks another attempt. There is no automatic rollback, journal deletion or retry.

This remains a trusted single-writer operation, not a filesystem transaction or
authenticated approval system. Other processes can race the final observation
and rename. Interrupted writes may leave a temporary file or incomplete journal;
power-loss durability and recovery are not established. Conflict resolution and
stable executable version switching remain future work.

## Prepare and inspect

Create an [independent candidate](candidates.md), then use its returned directory:

```sh
bun start task prepare <candidate-directory>
bun start task check <candidate-directory>
```

Preparation requires an unchanged candidate and an applicable registered
definition. It returns the objective, oracle, permitted files, required status
when applicable and limits, then exclusively saves `task.json` beside the
checkout. Version 3 plans persist the declared objective, oracle, read/write
scope, effects, limits and promotion policy, and bind the definition and oracle
SHA-256 plus every baseline input. Version 1 and 2 plans are intentionally unsupported;
retained records remain historical evidence but cannot reopen current authority.
An existing plan is never overwritten.

`task check` exits 0 for the exact correction and 1 for an unmet task assertion.
Invalid arguments, unavailable state or scope violations exit 2. The check
reports its observed write-set SHA-256 and baseline. Saved plans are strictly parsed
and compared with the baseline files; their provenance remains
`recorded_untrusted`. Editing JSON cannot expand the application's allowed scope.

## Enforced scope

The application-owned registry permits only listed relative paths, requires every
writable file to also be readable, rejects duplicate or parent-traversal
paths, and supplies strict request schemas to both the engine and Pi adapter.
Definitions are frozen at runtime. The model cannot load a definition from the
candidate, alter its promotion policy or select an oracle command.

There are at most eight reads, two replacements and three checks per active
handle. Each file and replacement is bounded to 64 KiB of valid UTF-8. Unknown
fields, unlisted paths, stale hashes, NUL and invalid Unicode are rejected.
The handle closes on an operation failure; concurrent use is rejected. A model
cannot select executable commands, create files, delete files, change permissions
or edit task metadata through this API.

Before operations, the adapter checks the checkout baseline and detects changes
outside the write set, including untracked and ignored paths. The read-only
context files must retain their baseline hashes. Writable-file changes must
match the handle's per-file last known content. Redirected paths and hard-linked files
are rejected. Replacement is written to an exclusive temporary file outside the
checkout, rechecked against current state, then renamed into the fixed target.

Each definition owns its appropriate deterministic, behavioral or formal check.
The new candidate-source task and documentation task require exact baseline-bound
bytes; the code task uses its isolated behavior oracle, and the formal task uses
LemmaScript/Dafny. A passing check establishes only its declared requirement.

## Authority and limits

`CandidateTask.prepare` creates an in-memory editing handle selected by trusted
application code. The preparation CLI closes that handle after printing the
plan. Loading `task.json` supports read-only checking; it does not recreate the
handle or reset an execution budget. `task run` creates a new candidate and handle
for each explicit invocation. `task recover` likewise grants authority only to a
new successor candidate after validating the old plan; it never reopens the old
handle or its budgets.

These are task-tool boundaries in a trusted single-writer workspace. They do not
sandbox a hostile same-user process, authenticate stored metadata, or guarantee
atomic observation of the entire filesystem. Failed writes may leave local
temporary state; there is no automatic rollback, same-candidate task resume or
automatic promotion.
An earlier check describes its observed bytes, not later edits. Checks always
retain `taskAcceptance: "not_evaluated"`; operator decisions are separate records.
