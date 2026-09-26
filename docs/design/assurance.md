# Assurance

A passing check shows that code meets its tests, not that the tests say what
the operator asked; an agent can also edit a test until it passes. Tesota
therefore surrounds each result with verification, review and a bounded
correction loop before the operator decides. Evidence for the choices below
is in the [review landscape](../research/agent-review-landscape.md), and
measurements are in [findings](../findings.md).

## Four roles

Each role answers one question, and none can do another's job.

| Role | Question | Performed by |
| --- | --- | --- |
| Authority | May this action happen? | The execution environment and approvals ([execution](execution.md)) |
| Verification | Does this exact candidate meet a stated claim? | Verifiers that Tesota runs |
| Review | Is this the result that was asked for, and does the evidence cover it? | Reviewers that Tesota launches |
| Acceptance | Is it adopted? | The operator |

Verification closes the gap between a stated specification and the code.
Review closes the gap between the intent and the specification. Tesota's own
code runs these steps; the working agent can neither skip them nor choose
what a reviewer sees.

## The candidate

A **candidate** is the workspace's pending changes, identified by their Git
tree, together with the operator's **request record** ([workspace](workspace.md)).
Every verifier and reviewer result names the tree it describes; a changed tree
needs new results.

Tesota flags, with fixed rules, changes to tests, check or lint
configuration, CI workflows, formal specifications, package scripts and its
own setup. Flags go to the reviewers and to the operator, marked ⚠: a flagged
change may be a legitimate fix or a way to make checks pass, and only the
operator decides which.

## Verifiers

A verifier runs on the frozen candidate and reports its outcome, the claim a
pass establishes, its limits, the environment and guarantees it ran under,
and the end of its output. A missing, unavailable, timed-out or unconfirmed
verifier is never reported as passed.

| Verifier | Claim |
| --- | --- |
| Approved check commands | The command exits with code 0 on this tree |
| Tesota's Oxlint profile | Changed JavaScript and TypeScript files introduce no diagnostics the profile rejects, such as a new `any` or a comment that silences a check |
| LemmaScript with Dafny | The `//@` properties of changed annotated files are proved; it runs on a private copy, and says nothing was proved when Dafny is missing |

The operator approves check commands once per repository; Tesota suggests the
repository's `check` script, or its `typecheck`, `lint` and `test` scripts,
using the lockfile's package manager, and `cargo test` or `go test ./...` for
Rust and Go. A check that changes files is reported as `changed_files`, and
the candidate must be reviewed again. The working agent may run the same tools
while it works; those runs are feedback, not evidence.

## Review

### Depth

Tesota computes each review's depth from facts about the candidate, never
from a model, and shows why. A review is **deep** when the candidate touches
security- or authority-sensitive paths, changes or deletes existing tests,
changes what checks it, leaves a verifier failing, or changes more than 400
lines; otherwise it is **standard**.

### Reviewers

Tesota's **reviewer** is a fresh Pi session with read-only file tools and no
shell. It receives the request record, the numbered diff, the verifier
results and the flags, never the working agent's reasoning, and submits
structured findings once. A reviewer that does not finish reports an
incomplete review, which is never shown as clean. Every request to a
reviewer, lens, ClaimCheck, the refuter or the fix validator stops after ten
minutes, answered or not, and counts as unfinished, so a stalled model stream
cannot hold a review; measured requests take seconds to two minutes (see
[the engine contract](agents.md#the-engine-contract)). A deep review adds focused
**lenses**, each reporting only within its focus: correctness and
regressions, security and authority, and the repository's own `AGENTS.md` or
`CLAUDE.md` rules when it has them. When LemmaScript proved contracts in the
candidate, a **ClaimCheck** reviewer restates each proved contract without
seeing the requests, then compares that restatement with them, which catches
a proof that holds but proves less than was asked.

### Findings

A finding has three independent dimensions:

| Dimension | Values | Set by |
| --- | --- | --- |
| Disposition | `fixable`: a defect against the request; `operator`: an ambiguity, a trade-off, a flagged change, scope growth or a security-sensitive choice | The reviewer |
| Origin | `introduced` by this candidate, `preexisting`, or `unknown` | The reviewer claims it; Tesota checks it |
| Standing | `confirmed`, `refuted` or `unsettled` | Tesota, from refutation |

**Origin is checked against the diff.** Reviewers read the diff with each
candidate line numbered, and Tesota compares every origin claim with the whole
candidate, base to tree. An `introduced` claim stands when the candidate
created or deleted the finding's file, or the finding's line, or any line of
its range, is one the candidate added or sits beside lines it only removed.
A `preexisting` claim stands unless the candidate created the file or added
the line. Anything else becomes `unknown`, with the reason recorded; evidence
Tesota cannot read, such as a binary file, never counts as proof either way.
The rule is `checkedOrigin` in `src/verification/finding-origin-rule.ts`,
proved by `bun run formal:check`. Without numbered lines, a replay over 137
recorded findings moved 21 real defects out of correction because models
counted lines from diff headers.

**Every finding faces a refuter.** A cold, read-only session that sees the
findings but not the reviewers' reasoning tries to disprove each one and
returns `confirmed`, `refuted` or `undetermined` (shown as `unsettled`). A
refuter that does not finish leaves every finding unsettled, never confirmed.
It also marks repeats: findings at nearby lines of one file are grouped for
it, and a finding is merged only into an earlier one in the same file with
the same origin, so a defect the change introduced is never hidden behind one
whose cause is unknown.

The operator sees ✗ for a confirmed fixable defect the change introduced, ⚠
for the operator's call, including a cause Tesota could not establish, `?
unsettled`, and `· already there` for what the change did not cause; refuted
findings are counted, with the refuter's evidence in the result panel.

## Correction

Failed or timed-out checks, and findings that are fixable, introduced,
confirmed and not a repeat, go back to the working agent in the same
conversation, with the request record unchanged. Tesota then verifies the new
candidate, has a **fix validator** confirm whether each finding sent back is
resolved, and reviews only the correction's own diff, so a round settles what
it was sent instead of raising a fresh list. At most two rounds run, fewer if
a round leaves the tree unchanged. Operator findings, unknown origins,
incomplete reviews and checks that could not run never go back to the agent.

## The record

Each workspace keeps an append-only **assurance journal**, `assurance.jsonl`
beside the checkout: for every reviewed candidate, the requests, each
verifier's claim and outcome, the flags, the depth, each reviewer's findings,
what the review step cost, and the operator's decision.

## Forecast

Before a deep review, Tesota writes one line: which sessions will run, and
what comparable reviews of this repository took (the median time and tokens of
reviews at the same depth, in the same kind of round, with the same models),
or that fewer than three have been measured. The review's summary then shows
what it took. Measurements are kept per repository, the latest twenty, and only
from steps in which every reviewer finished. Whether there are enough
measurements, which sorted positions are the median, and whether a step counts
are proved rules in `src/verification/review-estimate.ts`. The forecast asks
nothing: depth is computed from facts, correction rounds must not stall, and
`Ctrl+C` stops a review at any time.

## Measurement

`bun run live:review` runs eight frozen candidates with known truth: four
planted defects, a pre-existing bug, a correct control and two baits, with a
planted false claim on each correct candidate. It scores findings raw and
after refutation, measures correction on known good and cosmetic fixes, and
records time, tokens by kind and models. A change to a reviewer, the refuter, origin
checking, a prompt or a role's model is measured before it is adopted.

## Why

- **Tesota orchestrates, not an agent:** an orchestrating agent could skip
  the steps that produce evidence, and a working agent that invoked its own
  reviewer would choose when and how it is reviewed.
- **Read-only reviewers without the agent's reasoning:** a reviewer that
  could edit could change what it reviews, and one that shares the agent's
  reasoning shares its blind spots. Each role can use its own model
  ([agents](agents.md)), which widens independence beyond a fresh context.
- **Only introduced defects are sent back**, as in Codex's review rubric,
  Anthropic's code-review plugin and Gentle AI: a correction round should not
  change code the operator did not ask to change.
- **A finding is a hypothesis until something tries to break it:** Anthropic
  validates each issue, Gentle AI refutes before admission, and
  Refute-or-Promote showed model agreement endorsing a bug that one test
  disproved.
- **No mandatory up-front specification:** the request record and review
  cover the same risk with less ceremony.

## Planned

- Executable probes for findings the refuter cannot settle, if evaluations
  show unsettled findings in practice.
- Workflow profiles that choose verifiers, reviewers and loop limits per
  repository, once two real alternatives exist.
