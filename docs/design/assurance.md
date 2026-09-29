# Assurance

A passing check shows that code meets its tests, not that the tests say what
the operator asked; an agent can also edit a test until it passes. Tesota
therefore surrounds each result with verification, review and a bounded
correction loop before the operator decides.

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
Rust and Go. A check may also name the JUnit XML reports its command writes,
as `command => report, report`, relative to the repository and in paths Git
ignores; a check whose report Git does not ignore is not run, since writing
the report would change the reviewed files, and is reported as not started. A check that changes files is reported as `changed_files`, and
the candidate must be reviewed again. The working agent may run the same tools
while it works; those runs are feedback, not evidence.

**A failing check runs again on the base**, as a commit queue
retries a failure without the patch: Chromium's CQ fails a change only for
tests that fail with it and pass without it. When a check command fails or
times out on the candidate, Tesota runs it again, in the same environment, on
the candidate's base: the workspace pins the candidate's tree to a ref,
switches the checkout's tracked files to the base with `git read-tree --reset
-u`, which leaves ignored files such as installed dependencies in place, runs
the command, and restores the candidate, removing anything the run added;
reopening a workspace restores a candidate a stopped run left pinned. The
failure's origin is `introduced` when the base passes, `preexisting` when the
base ends the same way, and `unknown` otherwise, as when the base run could
not start, was stopped or changed files (`checkOrigin` in
`src/verification/check-origin-rule.ts`, proved by `bun run formal:check`).
The result panel and the reviewers see how the base ended beside the failure.
A session keeps each base run by command, reports, base and environment, so
correction rounds on the same base do not repeat it; a base run costs one more
run of the command, only when it fails.

**A check with reports is compared test by test**. Tesota
removes the check's reports before each run, on the candidate and on the base,
since ignored files outlast the switch to the base, and after a failed run
reads and merges them (`src/test-report.ts`): a test is failed when it has a
`failure` or `error`, skipped when it has `skipped`, and a test named twice is
failed when either run failed. A report that cannot be removed first, such as
a directory, a locked file or a path through a link, stops the check as not
started, and Tesota never removes or reads a report through a link. A test
that fails with the changes is `introduced` when it passes without them, or
when it has no result there although the base run wrote a report the candidate
named it in (`baseTestStatus`); it is `preexisting` when it fails there too,
and `unknown` when it was skipped there or its report was not written there
(`testOrigin`). A failing check is then `introduced` when the base passes, or
when the base failed or timed out too and some test is introduced, and
`preexisting` only when the base ends the same way and no test is
(`checkOrigin`, both proved by `bun run formal:check`). Tests can only make a
failure introduced: a report does not cover the rest of what a command, such as
a build or a linter, checks, so matching tests never make a failure
`preexisting` that the outcome alone would not. The panel, the reviewers and
the correction name the tests that fail only with the changes. Without a report
that can be read, as when the command stops before writing it, the comparison
is by outcome, and a candidate that adds a failure to a command that already
fails on the base is `preexisting`: the operator still sees the failure and
its output, but it is not sent back. A flaky test that fails only with the
changes costs a correction round.
Oxlint and LemmaScript judge only the changed files, so their failures always
come with the candidate.

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

### Obligations

A defect has a changed line to point at; missing work has
none. So the main reviewer also lists **obligations**: for each operator
request, the concrete things it asks for, and for each step of the agent's
plan that the agent marked done, whether it really happened.
It judges each against the whole result, unchanged files included, as
`met`, `partial`, `unmet` or `uncertain`, with the evidence. A plan step is
the agent's claim, given to the reviewer as a claim to check, never as an
account to trust. A main review that leaves a request or a claimed step
unassessed, or assesses one that does not exist, is incomplete
(`missingAssessments` in `src/integrations/pi-reviewer.ts`); focused lenses
and ClaimCheck report none.

Every **gap**, a partial or unmet obligation, faces the refuter with the
findings, numbered after them. An obligation **held** when the reviewer
found it met or the refuter disproved its gap, **did not hold** only when the
refuter confirmed the gap, and is **uncertain** otherwise, including a gap
nobody tested or settled; that rule is `obligationOutcome` in
`src/verification/obligation-outcome.ts`, proved by `bun run formal:check`.
The operator sees how many requests held, and how many claimed plan steps
held; each claimed step in the plan beside the prompt shows "held in
review", "not held in review" or "review uncertain", which is a judged
check, never shown as verified.

**The other direction.** Obligations catch work that is missing, not work
nobody asked for. So the main reviewer also checks each change in the diff
against the requests and claimed steps, and reports a change none of them
needs, such as a refactor of unrelated code or an unrequested abstraction,
as a finding for the operator's call, never sent back, since an extra may be
welcome; only an extra that breaks what was asked is a fixable defect. A
test of the code the change touched, edge cases included, a comment, and an
update a requested change forces on its callers are never extras. The
refuter confirms such a finding when the change is there and no request needs
it, and refutes it when one does or when it is one of those.

**A turn that changes no files is checked too.** Otherwise a reply could
stand in for requested code: asked to add a helper, an agent can answer that
it did. The main reviewer alone then judges the obligations against the
repository and the agent's final reply, which it is told is untrusted and
can never show that code exists; a question can be met by an accurate reply.
Gaps face the refuter, and confirmed ones go back to the agent for at most
two rounds; a correction that writes files is then reviewed as any change.
The result panel shows an "Answer check" with no application decision. While
a check leaves a request not held or uncertain, the request stays pending,
so "add farewell()" followed by "continue" is still checked as one request.
A cheap **first pass** comes before it, so a greeting does not cost the
strongest reviewer: a session on the `triage` role's model, `codex:gpt-6-luna`
by default and `off` to check every answer in full, with no file tools,
sees the pending requests and the reply and decides whether the turn holds
anything checkable, a request to change something, a follow-up to one, or a
claim about the code; when unsure it says checkable
(`src/integrations/answer-triage.ts`). The full check is skipped only when
the first pass decided that nothing is checkable; one that failed, timed out
or never decided runs it (`runsAnswerCheck` in
`src/verification/answer-check-rule.ts`, proved by `bun run formal:check`).
The first pass takes about two seconds; the full check is one reviewer
session, and the refuter's when there are gaps. This is the discretionary
review triage issue #124 asked a consumer for. The `triage` role may instead
use Jev, the typed decision model that issue proposes:
`typesafe:jev-1.13.0`, with the operator's TypeSafe key, answers the same
question with a probability in about a tenth of a second
(`src/integrations/jev-triage.ts`). It skips a turn only below 0.2, the
threshold registered with the first pass's cases before any model saw them,
and a refusal, an error, a missing key or no answer within ten seconds
decide nothing, so the same proved rule runs the full check. The version is
pinned: a newer one is offered only once it has been measured on those
cases. TypeSafe receives the turn's requests and reply, and says it does not
train on them.

## Correction

Each check, finding and assessed request or plan step has one **who acts**
decision, owned by `src/verification/review-action-rule.ts` and
proved with LemmaScript. `src/review-action.ts` translates the full review
record into that decision. Correction sends only `agent` items back; the
conversation groups items as **For the agent to fix**, **Needs you** and **For
context**. Cause, severity and the second check's standing remain separate
facts in the result panel. An unfinished review needs the operator and never
counts as a clean result.

Failed or timed-out checks the candidate introduced, findings that are fixable, introduced,
confirmed and not a repeat, and obligations that did not hold, go back to the working agent in the same
conversation, with the request record unchanged. Tesota then verifies the new
candidate, has a **fix validator** confirm whether each finding sent back is
resolved, and reviews only the correction's own diff, so a round settles what
it was sent instead of raising a fresh list; the main reviewer reassesses
every obligation against the whole current result. At most two rounds run, fewer if
a round leaves the tree unchanged. Operator findings, unknown origins, check
failures the base shares or that could not be compared with it, incomplete
reviews and checks that could not run never go back to the agent.

**The base stays fixed through the rounds**. A correction turn
does not bring the operator's newer repository state into the workspace, so
the correction's diff holds only the agent's work; with an update in between,
the operator's own edits would read as the agent's correction. That state
arrives with the operator's next request, which starts a new cycle.

## The record

Each workspace keeps an append-only **assurance journal**, `assurance.jsonl`
beside the checkout: for every reviewed candidate, the requests, each
verifier's claim and outcome, the flags, the depth, each reviewer's findings,
what the review step cost, and the operator's decision.

## Forecast

Before a deep review, Tesota writes one line: why it is thorough, how many
reviewers will look at the result, and how long comparable reviews took (the median time of
reviews at the same depth, in the same kind of round, with the same models),
or that fewer than three have been measured. The review's summary then shows
its time and tokens. Measurements are kept per repository, the latest twenty, and only
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
`--set=scope` runs five more: an out-of-scope refactor and an unrequested
abstraction, which break nothing and should be marked as the operator's call
rather than sent back; a quick hack that passes its checks; and a minimal and
a large but necessary control that should draw nothing. They are kept apart
so the eight cases' totals stay comparable.

Those candidates were written with Tesota's own prompts, and every model
measured finds their defects, so they guard the machinery rather than rank
reviewers. Review quality is measured on **SWE-PRBench**: 100 real pull
requests whose ground truth is their human reviewers' comments. Tesota's
reviewers and refuter answer each one from the benchmark's official context,
and the benchmark's own parser, judge, scorer and report score the answers
unchanged, before and after refutation.
