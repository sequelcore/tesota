# Receipt v3

The canonical JSON stored with a session and exported by `tesota receipt
--json`. Version 3 separates code checks, mechanical specification checks and
model opinions. None records human acceptance.

## Format

New writers emit `version: 3`. Terminal, Markdown and JSON use the same record.
The exported in-toto Statement names this page as its `predicateType`.
Unsupported versions, including v2, receive an explicit refusal. Original
v2 JSON retains its [v2 specification](receipt-v2.md); it is never relabeled,
migrated or reconstructed by current readers.

## Run metadata

| Field | Meaning |
| --- | --- |
| `version` | `3` |
| `repository`, `snapshot`, `tooLarge`, `reason` | Git/snapshot provenance, excluded paths or unavailable-measurement reason |
| `base` | Admission commit/snapshot, or null before the first commit |
| `startedAt`, `settledAt` | ISO 8601 timestamps |
| `engine`, `model` | Tesota version and session provider/model when known |
| `stopped`, `unresolvedQuestion` | Interrupted-run reason or remaining question |
| `requiredModel` | Optional operator-selected model identity and its check state |
| `changed` | Each changed path and final Git blob ID; null for deletion; `unreadable` when unknown |
| `lines` | Added/removed implementation, test and other lines, binary/generated paths; or `unreadable` |
| `inherited`, `unmeasured` | Unchanged dirty admission paths, and paths whose content could not be measured |
| `startState`, `endState` | Observed history/attribution state, including unknown reasons |
| `commentsOnly` | True when only comments/blank lines changed |
| `units` | Workspace units, each with folder, base, metadata and code/specification groups |
| `children` | Child sessions/outcomes, evidence about their own branches only |
| `floorRefusals` | Calls refused before execution, not evidence about allowed calls |
| `externalEffects` | Potential external writes, with server/tool/call and argument digest; persistence remains unverified |

Paths inside a unit are relative to it. Workspace mechanical records live in
its units; the root retains the admitted plan. Blob identities, checked-content hashes and
staleness retain their meanings. Export reports checked content that no longer
matches the commit and paths changed after settlement. A stopped receipt is an
inventory, never a verification pass.

### Required model

`requiredModel` holds `{selection, state}` when the session selected a model
with `--require-model`. `selection` records its project `folder`, model `path`,
ordered input `files` and their `contentHash`. Paths are relative to that
project; the folder is relative to the session. The hash uses the same
path/content SHA-256 binding as check evidence. Covered implementation files
are excluded from this fixed identity.

The option works in the terminal and print mode:

```sh
tesota --require-model models/Counter.tla
tesota -p --require-model models/Counter.tla "Update the implementation"
```

`state` is `checked` only when the selected inputs are unchanged and their
current model check and every declared fault completed successfully.
`changed` means a selected input was replaced or removed. `unchecked` means
the selected check remains incomplete, including a stopped run. The latter
two states are receipt gaps; a passing replacement cannot satisfy the original
selection. No selection is inferred from historical requests without one.

The selection is retained in the request journal across compaction, follow-ups
and resume. A new session explicitly selects revised inputs. It covers the
model, its configuration and its declared fault files/configurations; it does
not pin transitive imports or establish model/implementation conformance.

## Code evidence

| `codeEvidence` field | Meaning |
| --- | --- |
| `proofs` | Path, mechanical gate verdict and proof evidence |
| `tests` | Admitted project invocations, results and baseline comparisons |
| `exercises` | Changed/added test sensitivity and measured source sensitivity |
| `models` | Available model-check results, faults, code linkage and limits |
| `unheaded` | Changed design-model files without a model header |
| `unverified` | Paths no proof covers; measured test exercise can separately cover one |
| `uncovered` | Changed lines outside proof coverage |
| `checksAtStart` | Admission plan; absent when none was recorded |

Proof [Evidence](receipt-v2.md#evidence), model results and changed-line leaf
fields retain their existing documented meanings. A passing proof establishes
its contract within the verifier's model, not request fit.

### Admitted checks and attribution

`checksAtStart` contains `{folder, projects}`. Each project has an ownership
folder, commands, optional declaration hash and unavailable reason. Commands
retain execution folder, command text, timeout, report paths and selected
package-script/reporting options. The local absolute authorization root is not
exported. Stored selection grants no authority: trust and concrete invocation
identity are checked immediately before execution.

Command results retain `command`, `evidence`, gate `verdict`, failing test
identities and declaration identity. Optional `baseline` stores the comparable
base outcome/output, or why comparison never started. Optional `origin` has
`cause` and `reason`: `introduced` identifies a candidate-only failure;
`preexisting` requires reports identifying the same failures; `fixed` requires
a failed base and passing candidate; `unknown` preserves attribution gaps.
Passing both sides has no failure origin. Matching console text is insufficient.
Timeouts are not rerun on the base. Changed dependencies, authorization and
unfaithful starts remain explicit comparison gaps.

### Test and source exercise

Each test retains `path`, `provenance` (`added`/`changed`), `sensitivity`
(`fails_then_passes`/`passes_on_base`/`unknown`) and `reason`. This describes the
whole-base measurement. Optional source fields describe a different observation:

- `sources`: changed source paths whose isolated reversion produced a reported
  assertion failure in this test file.
- `sourceEvidence`: candidate control/confirmation bound to complete checked
  content.
- `sourceGaps`: uncredited paths and their reasons.

Each probe holds other candidate files/tests fixed. Passing candidate control
and confirmation surround the measurement. Missing imports, setup/runtime
errors, empty suites, skipped tests, unavailable reports and exhausted limits
grant no credit. Added sources that cannot load when absent may remain
unmeasured. A shared 120-second allowance covers source setup/measurement per
repository/request, including repairs; cancellation cleanup is awaited afterward.
One path's credit gives none to another, and stale evidence loses credit.
Sensitivity is neither intent correctness nor full coverage.

## Specification evidence

`specificationEvidence.contracts` contains `path`, `name`, contract `lines`
and mechanical `mutation` results. Rejected, surviving, equivalent and
inconclusive [mutation leaves](receipt-v2.md#contractstrength) retain their meanings.
There are no model judgments or restatements here.

`specificationEvidence.weakened` contains detected weakening edits or
`unreadable`/`too_large`. Existing kinds, annotations, test edits and heuristic
limits retain their meanings. A flag does not establish an illegitimate edit.
Vacuity is observed in the proof record, without a second independently
classified proof result.

## Request context

`requestContext.requests` retains `{run, text}` for original requests and their
ordered operator messages. Optional `clarifications` retains submitted
questions, choices and text. This context is separate from evidence, model
output, execution permission and acceptance.

## Request review

`requestReview.kind` is `model_opinion`. Its members are `contractComparison`,
`openCases` and stage-specific `context`. Opinions never affect mechanical
standing, required decisions, repairs or continuation.

### Contract comparison

`scope` is `eligible_changed_contracts`, never whole-request coverage.
`status` is `completed`, `partial`, `not_run` or `disabled`, with an explicit
`reason` when applicable. `contracts` contains checked identities and available
model output; `runs` contains unit/stage model identities and outcomes.

Each contract has `folder`, `path`, `name`, checked `text`, optional literal
`restatement` (`preconditions`, `postcondition`) and optional `assessment`
(`verdict`, `explanation`). Successful first passes and individual assessments
survive missing/failed later results. The model's qualitative strength rating
is not mechanical strength and is not stored as one.

Verdicts are `no_mismatch_identified`, `partial_match`, `mismatch` and
`suspected_vacuity`. These describe model reports, not guarantees. No mismatch
identified is not completeness; suspected vacuity is not a mechanically
observed zero-obligation proof.

Each run retains available `restatedBy`, `comparedBy`, `folder`, `failedStage`
and reason. Equal model IDs mean separate calls to one model, not independent
models. Missing models, disabled review, no eligible contracts, cancellation,
timeout, capacity omissions and unusable responses remain stated reasons.

### Open cases and actual context

Open cases are `{status: "listed", model, cases}` with `{input, outcomes}`
cases, or `{status: "not_run" | "disabled", reason, model?}`. Listed-empty
means only that the model listed none. The lister receives supplied request
context/references, not the agent's change.

Each context record retains `method`, `stage`, model when known, `folder`,
verbatim whole `requests` supplied, `omitted` request IDs and available
reference provenance/digests or missing-reference reasons. Stages are
`restatement`, `comparison` and `open_cases`. The blind restatement receives
no operator request. The other stages may receive different whole-request
suffixes under their context limits. Unavailable/omitted references are never
reported as reviewed; historical missing context stays unknown.

## Presentation and standing

Human-readable receipts show request context, code evidence, specification
evidence and visible `Request review — model opinion` status, including
disabled, unavailable and empty outcomes. Terminal details can fold.

`Evidence standing` is mechanical: `verified`, `incomplete`, `failed`,
`unverified` or `unchanged`. Verified requires current passing evidence for
every path without unresolved mechanical gaps/decisions. Passing checks can
coexist with model-reported mismatch.

Human-readable receipts close with **Acceptance remains with the reviewer.**
JSON contains no human-acceptance result.
