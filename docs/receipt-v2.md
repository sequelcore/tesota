# Receipt v2

This page specifies version 2 of Tesota's receipt. It is the in-toto
`predicateType` that `tesota receipt --json` writes:
`https://github.com/sequelcore/tesota/blob/main/docs/receipt-v2.md`. The
types are defined in `src/receipt.ts` and the modules it imports. The
Statement is built in `src/pull-request-receipt.ts`.
[How verification works](concepts/verification.md) explains the checks.

A receipt exists in two places:

- **In the session:** the `details` of a `custom_message` entry whose
  `customType` is `tesota-receipt`, or the `data` of a `custom` entry of
  that type in print mode. Outside print mode, a receipt with design model
  check entries uses `tesota-receipt-graphs`, even if graph capture was
  unavailable: `details.receipt` holds the same receipt v2,
  and `details.graphs` holds bounded transcript metadata, not receipt evidence.
  A message's `content` is its text; the shell draws from `details`.
  Presentation does not change the structured receipt or its version.
- **In a Statement:** inside an unsigned
  [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  about a commit. The Statement uses the predicate fields of the
  [agentic process evidence proposal](https://github.com/jfrog/agentic-process-evidence/blob/main/spec/agentic-process-evidence.md).

Optional fields are absent, never `null`, unless a field says otherwise.
Timestamps are ISO 8601 in UTC, as JavaScript's `toISOString` writes them.
Paths are relative to the project folder where the session ran, with `/`.

## The Statement

This schematic example abbreviates `custom.receipt`; placeholders are not
literal output values.

```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "uri": "git+https://github.com/owner/repo@<commit>", "digest": { "gitCommit": "<commit>" } }],
  "predicateType": "https://github.com/sequelcore/tesota/blob/main/docs/receipt-v2.md",
  "predicate": {
    "providers": [{ "harness": { "name": "tesota", "version": "0.1.0" },
      "languageModels": [{ "inferenceProvider": "openai/gpt-6-luna" }] }],
    "traceId": "<session id>",
    "custom": {
      "baseCommit": { "uri": "git+https://github.com/owner/repo@<base>", "digest": { "gitCommit": "<base>" } },
      "receipt": { "version": 2, "repository": true, "...": "..." },
      "stale": [],
      "changedAfter": []
    },
    "result": "COMPLETED",
    "owner": "login or email",
    "startTimestamp": "2026-10-08T17:00:00.000Z",
    "endTimestamp": "2026-10-08T17:04:00.000Z"
  },
  "createdAt": "2026-10-08T17:10:00.000Z",
  "createdBy": "tesota"
}
```

| Field | Value |
| --- | --- |
| `_type` | Always `https://in-toto.io/Statement/v1` |
| `subject` | One resource descriptor: the commit `HEAD` named when `tesota receipt` ran |
| `predicateType` | This page's URL |
| `predicate.providers` | One provider: `harness` is `tesota` with the receipt's `engine` version. `languageModels` lists each distinct model as `inferenceProvider`, as `provider/id`: the receipt's `model`, plus ClaimCheck's `restatedBy` and `comparedBy` when it judged, and the `openCases` model when it listed. It is absent when there are none |
| `predicate.traceId` | The id of the session the receipt came from |
| `predicate.custom.baseCommit` | The receipt's `base` as a resource descriptor; absent when `base` is null |
| `predicate.custom.receipt` | The receipt, specified below |
| `predicate.custom.stale` | Proof and design model paths, and command strings, whose evidence fails the checkout hash or Git cleanliness check (see below) |
| `predicate.custom.changedAfter` | The files whose content in the commit differs from what the run left (see below), or `"unreadable"` when Git could not tell |
| `predicate.result` | The process result the receipt states truthfully, from the values the agentic process evidence proposal defines: `CANCELLED` when the run stopped before Tesota verified it; otherwise `COMPLETED` when it stands `verified` or `unchanged`, and `FAILED` when it stands `failed`. A receipt that stands `incomplete` or `unverified` has no truthful result, so it isn't exported (see below) |
| `predicate.owner` | Who is accountable: `--owner`, or else Git's `user.email` |
| `predicate.startTimestamp`, `predicate.endTimestamp` | The receipt's `startedAt` and `settledAt` |
| `createdAt` | When `tesota receipt` wrote the Statement |
| `createdBy` | Always `tesota` |

A commit's resource descriptor is `{ "digest": { "gitCommit": <id> } }`.
When the `origin` remote can be written as an HTTPS URL, it also has
`"uri": "git+<url>@<id>"`, with the URL's `.git` removed; SSH and scp-style
remotes are converted.

Proof, command or design model evidence is stale when export cannot
confirm its checked content in the current checkout and commit. This
happens when the SHA-256 of its `files` no longer matches its `contentHash`
in the checkout, or when Git shows any of those files as changed or
untracked.

**`changedAfter`** compares Git blob ids, so line-ending conversion changes
nothing. It lists, sorted:

- every file the commit changed from the receipt's base (or from the empty
  tree, when `base` is null) that the receipt's `changed` does not record;
- every recorded file whose blob in the commit differs from the recorded
  one, a file the commit lacks counting as `null`.

The Statement is not signed. Only a receipt with `version` 2 and
`repository` true is written as a Statement; a stopped run's receipt is
written with `result` `CANCELLED`. `tesota receipt --json` refuses, and
exits 1, when the receipt stands `incomplete` or `unverified`, or when the
commit doesn't hold exactly what the checks saw: when `stale` or
`changedAfter` lists anything, or Git could not tell which files changed.
It names what changed and suggests running the request again.
`tesota receipt` without `--json` still writes the receipt as Markdown,
with those files named. A receipt with `units` cannot be exported as
a single Statement. Run `tesota receipt` in one of its repositories to
export that repository's unit as a receipt of its own, with the run's `version`, `startedAt`,
`settledAt`, `engine`, `model`, `clarifications`, `unresolvedQuestion` and
`stopped`, when present, and the unit's `folder` kept. The same refusals
apply.

## The receipt

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `2` | This format |
| `repository` | boolean | Whether the unit is a Git repository. Without a repository or `snapshot`, no checks establish the changes and `base` is null; request context can still be present |
| `snapshot` | `true`, optional | Present when the project has no Git repository and Tesota measured the request against its own snapshot of it. `base` is then that snapshot's commit, which no one else can fetch |
| `tooLarge` | string[], optional | With `snapshot`, the files the snapshot left out for being over 10 MiB, so nothing verified them |
| `reason` | string, optional | When nothing was verified, why: Tesota does not snapshot a home folder or a drive's root, or the folder is past a snapshot's limits. On a stopped run, why `changed` is `unreadable` |
| `stopped` | string, optional | Why the run ended before verification completed, including interrupted or unstarted checks. Claims no evidence and reads incomplete. `changed` holds a read-only inventory or `"unreadable"` with `reason`; inventory has a 30-second limit. Recovery after process death records `changed: "unreadable"` because no final inventory was saved. See [Stops and recovery](concepts/verification.md#stops-and-recovery) |
| `unresolvedQuestion` | string, optional | The unresolved question that ended generation. The run is incomplete; the receipt still records verification of its changes |
| `base` | string or null | The commit `HEAD` named when your request started, or Tesota's snapshot then. Null before the first commit and when nothing was verified |
| `startedAt` | timestamp | When your request started |
| `settledAt` | timestamp | When the run ended |
| `engine` | string | The Tesota the run used. A released binary: its plain version. A build from source: the version, `+`, the first eight characters of the commit of Tesota's own checkout (never the workspace's), and `.dirty` when that checkout has changes, as `0.1.0-alpha.3+d4175524.dirty`; `+unknown` when Git can't read that commit. Read once, when the first receipt needs it |
| `model` | string, optional | The session's model when the run ended, as `provider/id` |
| `proofs` | Proof[] | Each changed file with contracts that was proved |
| `contracts` | ContractStrength[] | Each contract the request added or changed in a file that proved |
| `claimcheck` | ClaimCheckRun, optional | Which models ClaimCheck asked, or why it judged nothing. Absent when `contracts` is empty |
| `tests` | CommandRun[] | Each project command verification ran |
| `exercises` | TestExercise[] | Each changed or added test file run over the base |
| `models` | ModelResult[], optional | Each design model whose own files or covered files the request changed, checked with TLC, or kept from the session's passing check of the same content. Describes what the design model check established about its declared abstraction. Absent when the request touched no design model |
| `unheaded` | string[], optional | TLA+ (with a `.cfg` beside it) and Quint files the request changed that declare no `tesota-model` header and no design model names as a fault, so nothing checked them |
| `weakened` | Weakening[], or `"too_large"`, or `"unreadable"` | The changes that may weaken the evidence. `too_large` when Git's diff from the base passed 16 MiB; `unreadable` when Git could not show it |
| `unverified` | string[] | Changed files no proof's evidence covers, other than test files and files whose changed lines are all blank or comment-only |
| `commentsOnly` | `true`, optional | Present when every line the request added or removed is blank or comment-only, a `//@` line not counting as a comment. When nothing else is listed, the receipt says there was nothing to verify |
| `uncovered` | UncoveredLines[] | The changed lines of each TypeScript file that proved that no contract's proof covers. Empty when `weakened` is a string |
| `changed` | Changed[], or `"unreadable"` | Files changed during the request (by anyone), as the run left them, sorted by path: differences between fingerprints plus files changed between `base` and current `HEAD`, and the proof files (`.dfy`, `.dfy.gen`) that verification's own proving changed from `base`. Unmeasured paths are listed separately. On a stopped run, the same inventory, read and never checked |
| `lines` | ChangeLines, or `"unreadable"` | The files in `changed` in lines by category. `unreadable` when Git could not show the change |
| `inherited` | string[] | Paths dirty at the first non-reader tool whose blobs stayed unchanged; not proved or exercised as this request's change. Tests ran with them |
| `unmeasured` | { path: string, reason: string }[] | Paths not hashed at either capture: a dirty file over 10 MiB or an untracked directory with 200 or more files. These require verification of the repository or folder because its content may have changed |
| `startState`, `endState` | CaptureState, optional | Each repository's capture at the first non-reader tool and at final verification. Absent for snapshots, runs recovered after their process ended, older receipts, and when no capture was taken |
| `units` | Unit[], optional | Per-folder evidence when the session runs outside Git across folders. Top-level check lists and change inventory are empty, `repository` is true and `base` is null; shared run metadata remains at the top level |
| `openCases` | OpenCases, optional | Cases your request leaves open, as a model listed them for you to resolve. These suggestions appear separately from check evidence and do not count toward decisions required by the receipt. Absent when listing is disabled with `--open-cases-model off` or the `openCasesModel` setting. Uses the flag, then the setting, then the session's model by default; an unavailable model records a `not_listed` reason |
| `requestJudgments` | RequestJudgment[], optional | The requests supplied to each model-judged step, and any omitted for model context capacity. Context, not check evidence or acceptance; absent when no request-context judgment was attempted |
| `clarifications` | Clarification[], optional | Explicitly submitted answers to the agent's questions, in submission order. Records request context; submitting an answer does not establish check evidence, execution permission or acceptance. Absent when no batch was submitted |
| `children` | Child[], optional | The [subagents](guides/subagents.md) the run started, in the order they ended: who did what. Each child's receipt covers its own branch; the parent checks adopted changes in its workspace. Absent when the run started none |
| `floorRefusals` | FloorRefusal[], optional | The calls Tesota's [floor](guides/permissions.md#the-floor) refused in the request, in order: `tool`, `subject` (what the call named, on one line and cut to 80 characters) and `reason`. Rendered without `subject`, which may be a secret's path. A refusal records that one call did not run. It does not establish what ran instead and contributes neither check evidence nor a standing decision. Absent when there were none |

### RequestJudgment

Each entry describes one model-judged prompt, independently budgeted for its
model. A workspace can have several ClaimCheck comparisons, one per unit.
A repository's pull-request export retains only that unit's ClaimCheck
entries and the shared open-cases context, in both JSON and Markdown.

| Field | Type | Meaning |
| --- | --- | --- |
| `method` | `"open_cases"` or `"claimcheck"` | Which model-judged step received the requests |
| `folder` | string | The ClaimCheck unit's folder, or the empty string for the root or shared open-cases context |
| `requests` | { run: number, text: string[] }[] | Whole requests supplied, oldest first. `run` is the session's request number; `text` is its original text followed by operator amendments and clarifications in order. Extension input is excluded |
| `omitted` | number[] | Earlier request numbers left out for context capacity, oldest first. Empty when all fit. No request is truncated |

For example, `ClaimCheck context: requests 1 and 3` names the supplied
context. `ClaimCheck left out request 2: context capacity` makes an omission
explicit. If even the newest whole request or fixed prompt does not fit,
nothing is judged; the receipt records no supplied requests and lists all
omitted request numbers. The model result explains why it could not run.

The chain includes requests since the last final successful verifier
settlement with a non-stopped receipt. A completed answer without a receipt
does not end it. A stopped receipt is only an inventory, never this boundary.
An intermediate receipt followed by resumed generation and a crash does not
end the chain either. Context supplied to a model is not a claim that the
model returned a usable judgment; its result is recorded separately.
Capacity is estimated using Tesota's shared context estimator, including
the system prompt, tool schema, contracts and restatements where applicable,
and reserving the model's maximum output tokens. The newest contiguous
suffix of whole requests that fits is supplied. Each model can therefore
receive a different suffix. These are token estimates, not exact provider
token counts.

### Standing

Standing is derived from the receipt rather than stored as a field. Print
mode, the footer, the dashboard and a subagent's end use the same decision.
A check that could not run, or whose evidence is unavailable or stale,
leaves a gap. That gap makes the run incomplete, or unverified if nothing
else passed.

| Standing | Shown as | When |
| --- | --- | --- |
| `failed` | `failed` | A check ran and showed the change wrong |
| `incomplete` | `incomplete` | The run stopped or needs a decision without the failure condition above; or evidence passed but a gap remains or a changed path isn't covered |
| `unchanged` | Print: `Completed (nothing to verify)`; elsewhere: `nothing to verify` | Nothing changed: no path the receipt records as changed, and no change of comments alone. There's nothing to claim |
| `unverified` | `unverified`, and why | Something changed, and no proof, command or design model passed on current content |
| `verified` | `verified` | None of the above: evidence passed, no gap, every changed path covered, nothing to decide, not stopped |

For standing, changed paths are collected from `changed`, `unverified`,
`proofs`, `uncovered` and `models`. Coverage is evaluated separately for
each unit: a repository or snapshot folder with its own checks.

A path counts as covered if `unverified` does not list it. Test files and
comment-only changes are excluded from that list. A listed path can also
count as covered through tests, but only when all these conditions hold:

- It is the only path in the unit's `unverified` list.
- The unit ran at least one command, and every command passed.
- The unit records at least one exercise, and every exercise has
  `sensitivity: "fails_then_passes"`.

The receipt does not map a test to the implementation file it exercises.
If two files lack proof coverage, test exercise cannot establish which
one was tested. Both remain coverage limits.

A gap is a verification limit, such as uncovered lines, a check that could
not run, stale evidence or an uncertain starting point for measuring the
request's contribution. An unreadable `changed` inventory also leaves a
gap because Tesota cannot establish coverage of every changed path.

A green summary means `verified`; a run that verified nothing is amber.
A file covered through tests is shown as a muted line, such as
`add.js: tested and exercised; no proof covers it`, and does not count as a
coverage limit. A file without coverage remains a limit.

### Clarification

Each batch has `reply` (zero-based assistant reply within the run), `callId`,
`at` (submission timestamp), `questions` and `answers`. Together the reply
and call identify the invocation; a call ID can recur in another reply.

A question has `question`, `options` (`label` and `description`), optional
`multiple` and optional `recommended` (zero-based option index). These words
were supplied by the agent. Its matching answer has `selected` (zero-based
option indices) and optional `text`, your words kept verbatim.
An answer can include both selections and text. Unsubmitted drafts,
dismissed questions and unavailable answers do not enter this list.

### Child

| Field | Type | Meaning |
| --- | --- | --- |
| `description` | string | What the agent asked it, in a few words |
| `type` | string, optional | Its agent type, when it had one |
| `model` | string, optional | Its model, as `provider/id` |
| `writes` | boolean | Whether it could change files, in a worktree of its own |
| `outcome` | string | How its run ended: `completed`, `aborted`, `error`, `incomplete`, or `unknown` when the process ended while it ran |
| `verification` | `verified`, `incomplete` or `failed`, optional | Where its own receipt stands ([Standing](#standing)), when its run ended with one. Absent when it stands `unverified` or `unchanged`, which this field doesn't store |
| `session` | string | Its session's file |
| `branch` | string, optional | The branch its work stays on, when it wrote something |
| `floorRefusals` | number, optional | How many of its calls Tesota's floor refused; its own session lists them |
| `unguarded` | `true`, optional | It could write and ran without Git's guard on its branch: its Git was older than 2.54 and `subagentBranchGuard` said `warn`, or the guard was `off` |

What a child changed counts toward the request only once the run brought it
into its own workspace, where this receipt's checks measured it.

### Unit

A unit is a repository or snapshot folder, in name order. It has the
receipt's `repository`, `snapshot`, `tooLarge`, `reason`, `base`, `proofs`,
`contracts`, `claimcheck`, `tests`, `exercises`, `models`, `unheaded`,
`weakened`, `unverified`, `commentsOnly`, `uncovered`, `changed`, `lines`,
`inherited`, `unmeasured`, `startState` and `endState` fields, with the same
optionality. Run metadata and request context stay on the parent receipt.
Paths and commands are relative to the unit. It also has:

| Field | Type | Meaning |
| --- | --- | --- |
| `folder` | string | The unit's folder, relative to the folder the session ran in, with forward slashes. Empty for that folder's own files |

A unit the request did not change has none. A folder in no repository,
and the folder's own files without the folders below (`folder` empty), are
measured against Tesota's snapshot of each, with `snapshot` true. One that
could not be snapshotted has a unit, with `repository` false, nothing
verified, `base` null and its `reason`, only when the request ran a tool
that may change files; a repository Git could not read is listed the same
way.

### CaptureState

`{ "status": "known", "head": <commit or null> }`, or
`{ "status": "unknown", "reason": <why> }` when Git failed or the index was
in conflict. An unknown capture still requires verification of the
repository or folder. Verification compares changed paths with `base`,
the commit recorded when your request started, and the receipt explains
what could not be read. A readable path name and `HEAD` do not establish
that the file's content was measured.

Contribution attribution determines whether the observed changes can be
credited to your request. It requires known captures and a starting `head`
equal to `base`. If ending `head` still equals `base`, these facts establish
credit, including null before the first commit.

When history moves, the end capture can include `history`:

| Field | Type | Required fact |
| --- | --- | --- |
| `sameBranch` | boolean | The branch is unchanged |
| `descends` | boolean | `base` is an ancestor of ending `HEAD` |
| `exclusive` | boolean | No commit in `base..HEAD` is reachable from a local branch, remote-tracking ref or tag as it pointed when your request started |
| `timely` | boolean | Every commit in that range has a committer date at or after the request's start, at Git's whole-second precision |

All four facts must be true. When your request starts, Tesota saves the
commit IDs named by refs that `base` does not already reach. Those IDs are
used for comparison but are not receipt fields. Missing or unreadable
facts prevent credit when history moves. A repository's first commit has
no starting commit from which to establish ancestry.

When Tesota cannot establish credit, it still records observed paths and
final blobs, including imported work, and checks the resulting checkout.
It omits measurements that depend on separating your contribution from
other changes: test exercise, contract strength and ClaimCheck.
`exercises` and `contracts` are then empty, and `claimcheck` is absent.
These empty lists mean the measurements were not made. Weakening flags
and line counts still compare with the request's starting commit. Stored
measurements are preserved, with a notice explaining the uncertainty.

Ordinary local commits, pushing them and merging a branch created during
the request can satisfy these rules. Importing commits reached by refs at
the request's start cannot. These facts do not prove authorship: another person's
new commits, future-dated commits, squash merges, cherry-picks and patches
can also satisfy them.

`inherited` means existing dirty paths whose content stayed unchanged;
it does not include imported work. A stash that removes old changes counts
as a change during the request, even if it restores the starting commit's
content. Tests run with inherited files, while exercise compares against
`base`, so inherited dependencies can distort that measurement. Snapshots
outside Git have empty `inherited` and `unmeasured` lists.

### Proof

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The TypeScript file |
| `verdict` | GateVerdict | Verification's last verdict on its proof |
| `evidence` | Evidence | The proof's evidence |

### CommandRun

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | string | The command, as a POSIX shell runs it from the project folder, such as `cd web && bun run check` |
| `evidence` | Evidence | The command's evidence |
| `failingTests` | string[], optional | The failing tests' names, sorted, from the JUnit XML reports the command wrote. Absent when it wrote none |
| `origin` | CommandOrigin, optional | Why it fails, from a run on the base. Present when it failed or ran past its limit and verification compared it with the base |
| `verdict` | GateVerdict | Verification's last verdict on the command |

### CommandOrigin

| Field | Type | Meaning |
| --- | --- | --- |
| `cause` | `"introduced"`, `"preexisting"` or `"unknown"` | `introduced`: the base passes, or some test fails only with the change. `preexisting`: the base fails the same way and its test reports show each failing test failing there too; the failure didn't go back to the agent. `unknown`: neither could be shown, such as without test reports, a base that can't be run, or a request that didn't start from it |
| `reason` | string | What showed the cause, or why it couldn't be shown |

### GateVerdict

`GateVerdict` records how verification handles a check: accept its pass,
request a repair, record a repeated failure or leave a limit for you.

| Value | Meaning |
| --- | --- |
| `proved` | The proof, command or design model passed |
| `send_back` | It failed or was vacuous and needs repair. Normally it goes back to the agent before the run ends. With `unresolvedQuestion`, generation has ended: the receipt records the failure without sending it back |
| `no_progress` | It failed or was vacuous, repeating a failure verification already sent back during the request |
| `operator` | It could not run, ran past its limit, was stopped, its evidence was invalidated when checked content changed before final verification, or, for a command, it failed as the base already did (`origin.cause` `preexisting`); the operator's to resolve |

### Evidence

| Field | Type | Meaning |
| --- | --- | --- |
| `verifier` | `"lemmascript"`, `"command"` or `"tlc"` | LemmaScript with Dafny, a project command, or TLC on a design model |
| `claim` | string | What a pass establishes, in words a reviewer can confirm |
| `limits` | string | What a pass does not establish |
| `outcome` | Outcome | How the run ended; `not_started` when invalidated at final verification, since the current content was not checked |
| `invalidated` | `"content_changed"`, optional | Final verification found that the current `files` no longer matched `contentHash`. The receipt renders this evidence as stale, not as a check that did not run. The verdict is `operator` and outcome is `not_started`; the original hashes, duration and output remain, with a stale note appended to the output |
| `output` | string | The end of what the verifier printed: at most the last 8,192 characters of a process's output, with a note after a vacuous proof. Or why it did not run |
| `durationMs` | number | How long the run took, in milliseconds |
| `files` | string[] | The files the run checked, in the order `contentHash` covers them: for a proof, the TypeScript file and then its `.dfy`; for a command, the changed files; for a design model, the design model, a TLA+ model's `.cfg`, each fault (with a TLA+ fault's `.cfg`), then each covered file |
| `contentHash` | string | Lowercase hex SHA-256 of the UTF-8 JSON array `[[path, content], …]` for `files` in order, `content` being the file's text or `null` when unreadable, as `JSON.stringify` writes it |

`invalidated` records the reason final verification rejected existing evidence, not a
second verification status. The hashes detect the content mismatch; this
reason lets a saved receipt distinguish it from a verifier that never
started, without interpreting words in `output`.

The `outcome` values are:

| Value | Meaning |
| --- | --- |
| `passed` | A proof that regenerated, checked cleanly and verified at least one obligation, a command that exited 0, or a design model whose declared properties hold in every reachable state as configured, with every planted fault caught or unfinished |
| `failed` | A proof whose regeneration or check failed, a command that exited non-zero, or a design model with a property violation (including deadlock, liveness, assumption or assertion failure), a malformed specification, or a planted fault that passed, was malformed or reached no state |
| `vacuous` | A proof that checked cleanly but verified nothing, or a design model with no reachable state or no planted fault |
| `timed_out` | It ran past its limit: 5 minutes for each proof process and each TLC run, 15 minutes for a command |
| `cancelled` | It was stopped |
| `not_started` | It could not start, for example when Dafny is not installed; with `invalidated`, a run checked earlier content but the current content was not checked |

### ModelResult

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The design model file |
| `language` | `"tla"` or `"quint"` | Its language, by extension |
| `header` | ModelHeader | What its header declares |
| `problems` | string[] | What the header misses; the design model went back without running TLC while any was listed |
| `evidence` | Evidence | The check's evidence, with `verifier` `tlc` and the outcome verification judged: the design model's run and its planted faults together |
| `run` | `"passed"`, `"vacuous"`, `"violated"`, `"malformed"`, `"timed_out"`, `"cancelled"` or `"not_started"` | How TLC ended on the design model itself; `passed` establishes the declared properties in every reachable state of the design model as configured |
| `states` | number | The distinct states TLC reported; 0 when it reported none |
| `faults` | FaultCheck[] | Each planted fault TLC ran, once the design model passed |
| `counterexample` | Counterexample, optional | The steps to the broken property, when `run` is `violated` |
| `staleness` | `"current"`, `"possibly_stale"` or `"unknown"` | Whether a covered file differs from the `confirmed` commit; `unknown` without one or when it isn't in the repository; always `current` for a design model written with its code whose check passed |
| `stale` | string[] | The covered files that differ from it |
| `writtenWithCode` | boolean | The request changed both the design model's own files and a covered file, so the evidence counts as weaker |
| `link` | `"no_replay"`, `"linked"` or `"replay_failed"` | Whether the header's `replay` command passed after the design model did. `linked` records that replay; it does not prove the design model matches all code behavior |
| `verdict` | GateVerdict | Verification's last verdict on the design model |

A ModelHeader has `covers` ({ path, names }[], the files from the project
root and the functions named), `invariants`, `atomic` and `omits`
(string[]), `faults` ({ path, description }[]), and optional `confirmed`
and `replay` (string). A FaultCheck has a fault's `path` and `description`,
its `verdict` (`"caught"`, `"passes"`, `"broken"` or `"unrun"`), the end of
TLC's `output` and `durationMs`. A Counterexample has the `violation` TLC
reported and `steps`, each `{ action, changes }`: the action TLC names and
the variables it changed, as `name = value`, all of them for the initial
state.

### ContractStrength

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The TypeScript file |
| `name` | string | The function the contract governs |
| `lines` | string[] | The contract's `//@` lines as written, trimmed |
| `mutation` | Mutation | What proof-based mutation found |
| `judgment` | object, optional | ClaimCheck's `verdict` and `explanation`, present when ClaimCheck judged. The model's assessment of the contract, kept separate from proof evidence |
| `restatement` | object, optional | ClaimCheck's plain-words reading of the contract, `preconditions` and `postcondition`, by a model that didn't see the request. Present when the restating pass answered, even if no `judgment` followed. A model's opinion, not proof evidence |

`judgment.verdict` is one of:

- `justified`: expresses what was asked;
- `partially_justified`: covers only part of it;
- `not_justified`: does not express it;
- `vacuous`: proves nothing beyond its assumptions.

`judgment.explanation` is the comparing model's reason.

**Mutation** has these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `rejected` | number | Mutants whose proof failed: the contract rules them out |
| `survived` | Mutant[] | Mutants that still proved and were not proved equivalent: behavior the contract does not rule out. A contract with any is a weak contract |
| `equivalent` | number | Mutants that still proved and that Dafny proved return the same result as the code |
| `inconclusive` | number | Mutants whose proof timed out, was stopped or could not run |

At most 8 mutants are tried per contract.

A **Mutant** has these fields:

- `line`: 1-based, in the file;
- `operator`: `result`, `comparison`, `constant` or `arithmetic`;
- `before`: the text replaced;
- `after`: the text that replaced it.

### ClaimCheckRun

One of:

- `{ "status": "judged", "restatedBy": "<provider/id>", "comparedBy": "<provider/id>" }`.
  When the two are equal, one model made both requests.
- `{ "status": "not_judged", "reason": "<why>" }`. The reasons are:
  - no model is selected;
  - the restating model is not among Tesota's models;
  - a request failed, ran past its 5-minute limit, was stopped, or recorded
    no answer;
  - a contract was left without a comparison.

### OpenCases

One of:

- `{ "status": "listed", "model": "<provider/id>", "cases": [...] }`. Each
  case is `{ "input": "<the input>", "outcomes": ["<a result someone could expect>", ...] }`;
  `cases` is empty when the model found none. The model reads the
  messages you supplied for the request, without the change.
- `{ "status": "not_listed", "reason": "<why>" }`. The reasons are:
  - the model is not among Tesota's models;
  - the model reports that listing depends on reference contents missing
    from the request, naming what it cannot read;
  - its request failed, ran past its 2-minute limit, was stopped, or
    recorded no answer.

### TestExercise

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The test file |
| `provenance` | `"added"` or `"changed"` | `changed` when the base held the file and this request changed it; `added` when this request added it, so what it expects is the request's own |
| `sensitivity` | `"fails_then_passes"`, `"passes_on_base"` or `"unknown"` | Whether the test detects the change, passes without it, or could not be measured reliably; see below |
| `reason` | string | Why, in words |

`fails_then_passes` requires a failure on the base that is absent without
the changed test, or newly failing tests distinguished by reports when
the base already fails. The same checking command must pass with the whole
change in the worktree environment. A per-file runner must report tests
from the credited file that actually ran and passed. Empty-suite exit
success is insufficient. `passes_on_base` means the test also passed there;
other results are `unknown`.

Provenance and sensitivity are separate facts. A test that
fails then passes notices the change, but may expect the wrong thing; one
that passes on the base doesn't depend on the change, but may still guard
against a regression. Only changed and added test files are listed: tests
the request left alone run in the project's commands, not one by one on the
base.

### ChangeLines

| Field | Type | Meaning |
| --- | --- | --- |
| `implementation`, `tests`, `other` | { added: number, removed: number } | Each category's text lines: added and removed as `git diff --numstat` counts them against `base`; an untracked file, or any file before the first commit, counts as added whole, a symbolic link as its one line. A changed file Git finds no different from the base, such as one the request restored, counts nothing |
| `binary` | string[] | The files Git counts no lines for, such as images, or untracked ones that hold a NUL byte |
| `generated` | string[] | The files the repository marks as generated, whatever category they count in: a generated test counts in `tests` and is listed here |

`lines` is `"unreadable"` when Git could not show the change or an untracked
file could not be read. A partial count would leave a file unaccounted for.

A file's category, in this order: `tests` by verification's test paths; then
`other` when the repository marks it as generated (`linguist-generated` in
`.gitattributes`) or it is in no programming language, such as
documentation, configuration (including a tool's configuration written in
one, such as `vite.config.ts` or `.eslintrc.js`), a manifest or lockfile,
SQL, or an asset; then `implementation`. A category describes the type of
changed content. It does not assess risk or verification coverage. In a folder of repositories, the receipt's
one row adds every unit's lines together.

### Weakening

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The changed file |
| `kind` | string | One of the kinds below |
| `annotation` | string | For the first four kinds only: the line as written, trimmed, or `lemma <name> without a body` |
| `function` | string, optional | For an `//@ extern`: the function it trusts without proof; for an `//@ skip`: the function, class, variables or method it leaves out of the proof, or that holds the statement it leaves out; for an `//@ verify`: a function it leaves out. Present when Tesota found it |
| `statement` | `true`, optional | For an `//@ skip`: it leaves out a statement of `function`, not all of it |
| `script` | string | For `changed_check_script` only: the package script selected at the request's base |
| `tests` | WeakenedTest[], optional | For `edited_test` only: how the edit may weaken each test, for a JavaScript or TypeScript test file read on both sides. Present when Tesota recognized at least one |

The kinds are:

- `removed_contract`: a `//@ requires` or `//@ ensures` removed or changed;
- `added_requires`: a `//@ requires` added to a function the base had;
- `added_assume`: an added `//@ assume` or `//@ extern`, or, in a `.dfy`, an
  added `assume`, `{:axiom}` or lemma without a body written by hand: not a
  line of the program LemmaScript generated, its `.dfy.gen`;
- `added_skip`: an added `//@ skip` on something the base had, which
  LemmaScript leaves out of the proof, or a function the base proved that a
  `//@ verify` on others now leaves out, with `//@ verify` as its
  `annotation`;
- `deleted_test`: a test file deleted;
- `edited_test`: a test file edited so that it may weaken its tests: a
  removed line that is not blank, comment-only, a widened import or an
  extended line (one that only gains list items, such as arguments), or an
  added focus or skip marker, setup or teardown hook, or module mock; a
  removed line that only holds assertions the edit made stricter, where the
  new check implies the old one, doesn't count;
- `changed_check_script`: a package check script selected at the base whose
  command changed or is no longer selected. This includes removing the
  script or its manifest, and adding `check` so discovery no longer selects
  `typecheck`, `lint` or `test`. It does not judge the replacement's strength.

### WeakenedTest

Heuristic findings from the parts of the diff Tesota recognizes. The list
may miss other changes to the tests.

| Field | Type | Meaning |
| --- | --- | --- |
| `test` | string, optional | The test or group, with the groups around it, `a › b`; absent for code outside every test |
| `edits` | TestEdit[] | What the edit did to it, in the order found |

The receipt's text names the first ten tests and how many more; the JSON
keeps them all.

A TestEdit has a `kind` and the fields that kind names:

- `removed_assertion`, `assertion`: an `expect` assertion with no
  counterpart in the test, as written with its blanks collapsed;
- `loosened_assertion`, `subject`, `before`, `after`: the assertion on
  `subject` (`expect(…)`) given a weaker matcher or a wider expected value,
  `before` and `after` its matchers with their arguments;
- `dropped_not`, `subject`, `before`, `after`: the same, with its `not`
  dropped;
- `changed_assertion`, `before`, `after`: an assertion changed otherwise,
  whole on each side;
- `skipped`, `marker`: the test or group skipped, conditionally or as a
  todo, `marker` as written, such as `it.skip`, `xit` or `{ skip: true }`;
- `focused`, `marker`: the test or group focused, such as `it.only` or
  `fit`, so the file's other tests don't run;
- `mocked_subject`, `module`: a new mock of the module the file is named
  after and imports, `module` as the mock names it;
- `deleted_test`: the test deleted while the file stays.

### UncoveredLines

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The TypeScript file that proved |
| `lines` | [number, number][] | Inclusive, 1-based line ranges in the file as changed, ascending and not adjacent. May be empty |

### Changed

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | A file changed during the request (by anyone), including deletions and untracked paths |
| `blob` | string or null | The blob id Git would store for its content (`git hash-object`), or null when the file was deleted |
