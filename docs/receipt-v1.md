# Receipt v1

This page specifies version 1 of Tesota's receipt. It is the in-toto
`predicateType` that `tesota receipt --json` writes:
`https://github.com/sequelcore/tesota/blob/main/docs/receipt-v1.md`. The
types are defined in `src/receipt.ts` and the modules it imports. The
Statement is built in `src/pull-request-receipt.ts`. The
[verification design](design/verification.md) explains what each finding
means.

A receipt exists in two places:

- **In the Pi session:** the `details` of a `custom_message` entry whose
  `customType` is `tesota-receipt`. Its `content` is the text the operator
  reads.
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
  "predicateType": "https://github.com/sequelcore/tesota/blob/main/docs/receipt-v1.md",
  "predicate": {
    "providers": [{ "harness": { "name": "pi", "version": "1.1.0" },
      "languageModels": [{ "inferenceProvider": "openai/gpt-6-luna" }] }],
    "traceId": "<Pi session id>",
    "custom": {
      "baseCommit": { "uri": "git+https://github.com/owner/repo@<base>", "digest": { "gitCommit": "<base>" } },
      "receipt": { "version": 1, "repository": true, "...": "..." },
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
| `predicate.providers` | One provider: `harness` is `pi` with the receipt's `pi` version. `languageModels` lists each distinct model as `inferenceProvider`, as `provider/id`: the receipt's `model`, plus ClaimCheck's `restatedBy` and `comparedBy` when it judged. It is absent when there are none |
| `predicate.traceId` | The Pi session id the receipt came from |
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

The Statement is not signed. Only a receipt with `version` 1 and
`repository` true is written as a Statement.

## The receipt

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | This format |
| `repository` | boolean | False when the project has no Git repository. Then every list is empty, `base` is null, and nothing was verified |
| `base` | string or null | The commit `HEAD` named when the operator's request started. Null before the first commit and outside Git |
| `startedAt` | timestamp | When the operator's request started |
| `settledAt` | timestamp | When the run settled |
| `pi` | string | The version of Pi the run used |
| `model` | string, optional | The session's model when the run settled, as `provider/id` |
| `proofs` | Proof[] | Each changed file with contracts that was proved |
| `contracts` | ContractStrength[] | Each contract the request added or changed in a file that proved |
| `claimcheck` | ClaimCheckRun, optional | Which models ClaimCheck asked, or why it judged nothing. Absent when `contracts` is empty |
| `tests` | CommandRun[] | Each project command the gate ran |
| `exercises` | TestExercise[] | Each changed or added test file run over the base |
| `weakened` | Weakening[], or `"too_large"`, or `"unreadable"` | The changes that may weaken the evidence. `too_large` when Git's diff from the base passed 16 MiB; `unreadable` when Git could not show it |
| `unverified` | string[] | Changed files no proof's evidence covers, other than test files and files whose changed lines are all blank or comment-only |
| `uncovered` | UncoveredLines[] | The changed lines of each TypeScript file that proved that no contract's proof covers. Empty when `weakened` is a string |
| `changed` | Changed[], or `"unreadable"` | Every file changed from `base` as the run left it, sorted by path |

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
| `proved` | The proof or command passed |
| `send_back` | It failed or was vacuous, and went back to the agent. A settled receipt holds none, since the run continues while one goes back |
| `no_progress` | It failed or was vacuous, repeating a failure the gate already sent back during the request |
| `operator` | It could not run, ran past its limit or was stopped; the operator's to resolve |

### Evidence

| Field | Type | Meaning |
| --- | --- | --- |
| `verifier` | `"lemmascript"` or `"command"` | LemmaScript with Dafny, or a project command |
| `claim` | string | What a pass establishes, in words a reviewer can confirm |
| `limits` | string | What a pass does not establish |
| `outcome` | Outcome | How the run ended |
| `output` | string | The end of what the verifier printed: at most the last 8,192 characters of a process's output, with a note after a vacuous proof. Or why it did not run |
| `durationMs` | number | How long the run took, in milliseconds |
| `files` | string[] | The files the run checked, in the order `contentHash` covers them: for a proof, the TypeScript file and then its `.dfy`; for a command, the changed files |
| `contentHash` | string | Lowercase hex SHA-256 of the UTF-8 JSON array `[[path, content], …]` for `files` in order, `content` being the file's text or `null` when unreadable, as `JSON.stringify` writes it |

The `outcome` values are:

| Value | Meaning |
| --- | --- |
| `passed` | A proof that regenerated, checked cleanly and verified at least one obligation, or a command that exited 0 |
| `failed` | A proof whose regeneration or check failed, or a command that exited non-zero |
| `vacuous` | A proof that checked cleanly but verified nothing (proofs only) |
| `timed_out` | It ran past its limit: 5 minutes for each proof process, 15 minutes for a command |
| `cancelled` | It was stopped |
| `not_started` | It could not start, for example when Dafny is not installed |

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
  - the restating model is not in Pi's model registry;
  - a request failed, ran past its 5-minute limit, was stopped, or recorded
    no answer;
  - a contract was left without a comparison.

### TestExercise

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The test file |
| `finding` | `"exercises"`, `"does_not_exercise"` or `"unknown"` | `does_not_exercise` when it passes on the base. `exercises` when it fails there while the base passes without it. `unknown` otherwise |
| `reason` | string | Why, in words |

### Weakening

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The changed file |
| `kind` | string | One of the kinds below |
| `annotation` | string | For the first three kinds only: the line as written, trimmed, or `lemma <name> without a body` |

The kinds are:

- `removed_contract`: a `//@ requires` or `//@ ensures` removed or changed;
- `added_requires`: a `//@ requires` added to a function the base had;
- `added_assume`: an added `//@ assume`, or, in a `.dfy`, an added `assume`,
  `{:axiom}` or lemma without a body;
- `deleted_test`: a test file deleted;
- `edited_test`: a test file edited so that it may weaken its tests: a
  removed line that is not blank, comment-only or a widened import, or an
  added focus or skip marker, setup or teardown hook, or module mock.

### UncoveredLines

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | The TypeScript file that proved |
| `lines` | [number, number][] | Inclusive, 1-based line ranges in the file as changed, ascending and not adjacent. May be empty |

### Changed

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | A file changed from `base`, untracked files included |
| `blob` | string or null | The blob id Git would store for its content (`git hash-object`), or null when the file was deleted |
