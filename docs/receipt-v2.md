# Receipt v2

This page specifies version 2 of Tesota's receipt. It is the in-toto
`predicateType` that `tesota receipt --json` writes:
`https://github.com/sequelcore/tesota/blob/main/docs/receipt-v2.md`. The
types are defined in `src/receipt.ts` and the modules it imports. The
Statement is built in `src/pull-request-receipt.ts`. The
[How verification works](concepts/verification.md) explains what each finding
means.

A receipt exists in two places:

- **In the session:** the `details` of a `custom_message` entry whose
  `customType` is `tesota-receipt`, or the `data` of a `custom` entry of
  that type in print mode. A message's `content` is the text the operator
  reads; the shell draws the receipt from `details`, and the presentation
  does not change the structured receipt or its version.
- **In a Statement:** inside an unsigned
  [in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
  about a commit. The Statement uses the predicate fields of the agentic
  process evidence proposal
  ([in-toto/attestation#600](https://github.com/in-toto/attestation/issues/600),
  specified in
  [jfrog/agentic-process-evidence](https://github.com/jfrog/agentic-process-evidence/blob/main/spec/agentic-process-evidence.md)).

Optional fields are absent, never `null`, unless a field says otherwise.
Timestamps are ISO 8601 in UTC, as JavaScript's `toISOString` writes them.
Paths are relative to the project folder where the session ran, with `/`.

## The Statement

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
| `predicate.custom.stale` | The proofs, by `path`, and the commands, by `command`, whose evidence the commit no longer holds (see below) |
| `predicate.custom.changedAfter` | The files whose content in the commit differs from what the run left (see below), or `"unreadable"` when Git could not tell |
| `predicate.result` | Always `COMPLETED`: the receipt exists only for a completed run |
| `predicate.owner` | Who is accountable: `--owner`, or else Git's `user.email` |
| `predicate.startTimestamp`, `predicate.endTimestamp` | The receipt's `startedAt` and `settledAt` |
| `createdAt` | When `tesota receipt` wrote the Statement |
| `createdBy` | Always `tesota` |

A commit's resource descriptor is `{ "digest": { "gitCommit": <id> } }`.
When the `origin` remote can be written as an HTTPS URL, it also has
`"uri": "git+<url>@<id>"`, with the URL's `.git` removed; SSH and scp-style
remotes are converted.

A proof or command is **stale** when its evidence does not hold for the
commit. This happens when the SHA-256 of its `files` no longer matches its
`contentHash` as they are in the checkout, or when Git shows any of those
files as changed or untracked.

**`changedAfter`** compares Git blob ids, so line-ending conversion changes
nothing. It lists, sorted:

- every file the commit changed from the receipt's base (or from the empty
  tree, when `base` is null) that the receipt's `changed` does not record;
- every recorded file whose blob in the commit differs from the recorded
  one, a file the commit lacks counting as `null`.

The Statement is not signed. Only a receipt with `version` 2 and
`repository` true is written as a Statement. A receipt with `units` is not:
run in one of its repositories, `tesota receipt` writes that repository's
unit as a receipt of its own, with the run's `version`, `startedAt`,
`settledAt`, `engine`, `model` and `clarifications`, and the unit's `folder` kept.

## The receipt

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `2` | This format. Version 2 gives each test its provenance and sensitivity apart, where version 1 had one `finding`, and adds `lines` |
| `repository` | boolean | False when the project has no Git repository. Unless `snapshot` is present, every list is then empty, `base` is null, and nothing was verified |
| `snapshot` | `true`, optional | Present when the project has no Git repository and Tesota measured the request against its own snapshot of it. `base` is then that snapshot's commit, which no one else can fetch |
| `tooLarge` | string[], optional | With `snapshot`, the files the snapshot left out for being over 10 MB, so nothing verified them |
| `reason` | string, optional | When nothing was verified, why: Tesota does not snapshot a home folder or a drive's root, or the folder is past a snapshot's limits |
| `base` | string or null | The commit `HEAD` named when the operator's request started, or Tesota's snapshot then. Null before the first commit and when nothing was verified |
| `startedAt` | timestamp | When the operator's request started |
| `settledAt` | timestamp | When the run settled |
| `engine` | string | The version of Tesota the run used |
| `model` | string, optional | The session's model when the run settled, as `provider/id` |
| `proofs` | Proof[] | Each changed file with contracts that was proved |
| `contracts` | ContractStrength[] | Each contract the request added or changed in a file that proved |
| `claimcheck` | ClaimCheckRun, optional | Which models ClaimCheck asked, or why it judged nothing. Absent when `contracts` is empty |
| `tests` | CommandRun[] | Each project command the gate ran |
| `exercises` | TestExercise[] | Each changed or added test file run over the base |
| `models` | ModelResult[], optional | Each model whose own files or covered files the request changed, checked with TLC, or kept from the session's passing check of the same content. Evidence about the model, never a proof of the code. Absent when the request touched no model |
| `unheaded` | string[], optional | TLA+ (with a `.cfg` beside it) and Quint files the request changed that declare no `tesota-model` header and no model names as a fault, so nothing checked them |
| `weakened` | Weakening[], or `"too_large"`, or `"unreadable"` | The changes that may weaken the evidence. `too_large` when Git's diff from the base passed 16 MiB; `unreadable` when Git could not show it |
| `unverified` | string[] | Changed files no proof's evidence covers, other than test files and files whose changed lines are all blank or comment-only |
| `commentsOnly` | `true`, optional | Present when every line the request added or removed is blank or comment-only, a `//@` line not counting as a comment. When nothing else is listed, the receipt says there was nothing to verify |
| `uncovered` | UncoveredLines[] | The changed lines of each TypeScript file that proved that no contract's proof covers. Empty when `weakened` is a string |
| `changed` | Changed[], or `"unreadable"` | Files changed during the request (by anyone), as the run left them, sorted by path: differences between fingerprints plus files changed between `base` and current `HEAD`. Unmeasured paths are listed separately |
| `lines` | ChangeLines, or `"unreadable"` | The files in `changed` in lines by category. `unreadable` when Git could not show the change |
| `inherited` | string[] | Paths dirty at the first non-reader tool whose blobs stayed unchanged; not proved or exercised as this request's change. Tests ran with them |
| `unmeasured` | { path: string, reason: string }[] | Paths not hashed at either capture: a dirty file over 10 MiB or an untracked directory with 200 or more files. These make the unit eligible and are never called unchanged |
| `startState`, `endState` | CaptureState, optional | Each repository's capture at the first non-reader tool and at settlement. Absent for snapshots and stopped runs |
| `units` | Unit[], optional | Present when the session ran in a folder that is in no Git repository and holds repositories directly. Then the fields from `snapshot` to `endState` are empty or absent, `repository` is true and `base` is null |
| `openCases` | OpenCases, optional | The cases the operator's request leaves open, as a model listed them for the operator to settle. A model's opinion, never evidence, and never one of the receipt's decisions. Absent when the operator ran Tesota with `--open-cases-model off` |
| `clarifications` | Clarification[], optional | Explicitly submitted answers to the agent's questions, in submission order. Request context, never evidence, execution permission or acceptance. Absent when no batch was submitted |
| `children` | Child[], optional | The [subagents](guides/subagents.md) the run started, in the order they ended: who did what. Never this receipt's evidence: a child's own receipt covers its own branch. Absent when the run started none |

### Clarification

Each batch has `reply` (zero-based assistant reply within the run), `callId`,
`at` (submission timestamp), `questions` and `answers`. Together the reply
and call identify the invocation; a call ID can recur in another reply.

A question has `question`, `options` (`label` and `description`), optional
`multiple` and optional `recommended` (zero-based option index). These words
were supplied by the agent. Its matching answer has `selected` (zero-based
option indices) and optional `text`, the operator's words kept verbatim.
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
| `verification` | `verified`, `incomplete` or `failed`, optional | Where its own receipt stands, when its run settled with one |
| `session` | string | Its session's file |
| `branch` | string, optional | The branch its work stays on, when it wrote something |

What a child changed counts toward the request only once the run brought it
into its own workspace, where this receipt's checks measured it.

### Unit

A unit is an eligible repository, or a folder in no repository,
in name order. A unit has the fields from `repository` through `endState` of the
receipt, about that unit alone, with paths relative to it and commands run
from it, and:

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
in conflict. An unknown capture keeps the unit eligible; verification
compares every changed path against the admission `base`, and the receipt
shows the reason. Limits keep paths unmeasured even if their names and
`HEAD` were readable.

The gate observes results, not authors. A stash that removes old dirt is a
change during the request, including when it restores the admission base's
content. Inherited paths appear in one collapsed card row, with the paths
under Ctrl+O. Weakening still compares all paths against the admission base.
Tests run with inherited files; exercise uses the admission base, so a test
relying on inherited changes may be misjudged. Folders outside Git retain
their per-request snapshots and have empty `inherited` and `unmeasured` lists.

### Proof

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The TypeScript file |
| `verdict` | GateVerdict | The gate's last verdict on its proof |
| `evidence` | Evidence | The proof's evidence |

### CommandRun

| Field | Type | Meaning |
| --- | --- | --- |
| `command` | string | The command, as a POSIX shell runs it from the project folder, such as `cd web && bun run check` |
| `evidence` | Evidence | The command's evidence |
| `failingTests` | string[], optional | The failing tests' names, sorted, from the JUnit XML reports the command wrote. Absent when it wrote none |
| `verdict` | GateVerdict | The gate's last verdict on the command |

### GateVerdict

| Value | Meaning |
| --- | --- |
| `proved` | The proof, command or model passed |
| `send_back` | It failed or was vacuous, and went back to the agent. A settled receipt holds none, since the run continues while one goes back |
| `no_progress` | It failed or was vacuous, repeating a failure the gate already sent back during the request |
| `operator` | It could not run, ran past its limit or was stopped; the operator's to resolve |

### Evidence

| Field | Type | Meaning |
| --- | --- | --- |
| `verifier` | `"lemmascript"`, `"command"` or `"tlc"` | LemmaScript with Dafny, a project command, or TLC on a model |
| `claim` | string | What a pass establishes, in words a reviewer can confirm |
| `limits` | string | What a pass does not establish |
| `outcome` | Outcome | How the run ended |
| `output` | string | The end of what the verifier printed: at most the last 8,192 characters of a process's output, with a note after a vacuous proof. Or why it did not run |
| `durationMs` | number | How long the run took, in milliseconds |
| `files` | string[] | The files the run checked, in the order `contentHash` covers them: for a proof, the TypeScript file and then its `.dfy`; for a command, the changed files; for a model, the model, a TLA+ model's `.cfg`, each fault (with a TLA+ fault's `.cfg`), then each covered file |
| `contentHash` | string | Lowercase hex SHA-256 of the UTF-8 JSON array `[[path, content], …]` for `files` in order, `content` being the file's text or `null` when unreadable, as `JSON.stringify` writes it |

The `outcome` values are:

| Value | Meaning |
| --- | --- |
| `passed` | A proof that regenerated, checked cleanly and verified at least one obligation, a command that exited 0, or a model that passed with every planted fault caught or unfinished |
| `failed` | A proof whose regeneration or check failed, a command that exited non-zero, or a model that broke an invariant, that TLC could not read, or whose planted fault passed or could not be read |
| `vacuous` | A proof that checked cleanly but verified nothing, or a model with no reachable state or no planted fault |
| `timed_out` | It ran past its limit: 5 minutes for each proof process and each TLC run, 15 minutes for a command |
| `cancelled` | It was stopped |
| `not_started` | It could not start, for example when Dafny is not installed |

### ModelResult

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The model file |
| `language` | `"tla"` or `"quint"` | Its language, by extension |
| `header` | ModelHeader | What its header declares |
| `problems` | string[] | What the header misses; the model went back without running TLC while any was listed |
| `evidence` | Evidence | The check's evidence, with `verifier` `tlc` and the outcome the gate judged: the model's run and its planted faults together |
| `run` | `"passed"`, `"vacuous"`, `"violated"`, `"malformed"`, `"timed_out"`, `"cancelled"` or `"not_started"` | How TLC ended on the model itself |
| `states` | number | The distinct states TLC reported; 0 when it reported none |
| `faults` | FaultCheck[] | Each planted fault TLC ran, once the model passed |
| `counterexample` | Counterexample, optional | The steps to the broken property, when `run` is `violated` |
| `staleness` | `"current"`, `"possibly_stale"` or `"unknown"` | Whether a covered file differs from the `confirmed` commit; `unknown` without one or when it isn't in the repository |
| `stale` | string[] | The covered files that differ from it |
| `writtenWithCode` | boolean | The request changed both the model's own files and a covered file, so the evidence counts as weaker |
| `link` | `"no_replay"`, `"linked"` or `"replay_failed"` | Whether the header's `replay` command passed after the model did. Only `linked` ties the model to the code |
| `verdict` | GateVerdict | The gate's last verdict on the model |

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
| `judgment` | object, optional | ClaimCheck's `verdict` and `explanation`, present when ClaimCheck judged. A model's judgment, never a proof |

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
  operator's messages for the request, not the change.
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
| `sensitivity` | `"fails_then_passes"`, `"passes_on_base"` or `"unknown"` | `fails_then_passes` when it fails on the base while the base passes without it, or the tests it adds newly fail there by the base's test reports, or, for a `bun test` script, the same holds with `--pass-with-no-tests`. `passes_on_base` when it passes on the base too. `unknown` otherwise |
| `reason` | string | Why, in words |

Provenance and sensitivity are two facts, never one score. A test that
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
file could not be read, never a count that leaves a file out.

A file's category, in this order: `tests` by the gate's test paths; then
`other` when the repository marks it as generated (`linguist-generated` in
`.gitattributes`) or it is in no programming language, such as
documentation, configuration (including a tool's configuration written in
one, such as `vite.config.ts` or `.eslintrc.js`), a manifest or lockfile,
SQL, or an asset; then `implementation`. A category says where lines are, never how risky
they are or what verified them. In a folder of repositories, the receipt's
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
  removed line that is not blank, comment-only or a widened import, or an
  added focus or skip marker, setup or teardown hook, or module mock;
- `changed_check_script`: a package check script selected at the base whose
  command changed or is no longer selected. This includes removing the
  script or its manifest, and adding `check` so discovery no longer selects
  `typecheck`, `lint` or `test`. It does not judge the replacement's strength.

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
