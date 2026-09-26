# 018: Check each finding's origin against the diff, and forecast deep reviews

Status: adopted 2026-09-25. Refines the origin dimension and the review depth
of [decision 016](016-review-precision.md). Evidence is in the
[agent review landscape](../references/agent-review-landscape.md#attributing-a-finding-to-the-change).
Adapts two ideas from Gentle AI's RDD (MIT) with attribution, unknown
causality and a descriptive forecast; it does not use Gentle AI's code or
protocol.

## Context

Under decision 016 the reviewer alone says whether the candidate introduced a
problem, and that claim decides where the problem goes: an introduced,
fixable, confirmed finding is sent back to the agent. A wrong `introduced`
sends the agent to change code the candidate never touched; a wrong
`preexisting` shows a defect as background. The refuter tests whether a
problem exists, not who caused it.

Tools that act on a change tie a finding to the lines it changed: GitHub code
scanning shows an alert on a pull request only when all its lines are in the
diff, and Codex's rubric requires a finding's lines to overlap it. SARIF says
a result with no baseline cannot be known to be new and should be shown.
Gentle AI's RDD lets native code alone classify causality: an unsupported
candidate-causal claim becomes unknown, unknown escalates to the human, and a
diff that cannot be read is absence of evidence, never proof.

A replay of that line-exact rule on the 137 findings of Tesota's recorded
evaluation runs moved 21 of 135 introduced claims to unknown, most of them the
planted authority defect, each cited one line away from the line that
changed. Pi's read tool returns files without line numbers, so reviewers
counted lines from the diff's hunk headers.

A deep review starts several model sessions, the reviewer, up to three lenses
and ClaimCheck, and then the refuter, without saying so first. Claude Code's ultrareview shows the scope and estimated cost before it
launches, and Claude Code Review shows each repository's average cost from
recent reviews. RDD's forecast "is descriptive, not a route".

## Decision

### 1. Origin gains `unknown`, and Tesota checks every claim against the diff

After the reviewers finish and before the refuter runs, Tesota compares each
finding's origin with the whole candidate's diff, from its base to its tree,
also in a correction round, because whatever the candidate introduced is the
agent's to fix whichever round wrote it.

| Claim | Stands when | Otherwise |
| --- | --- | --- |
| `introduced` | The candidate created or deleted the finding's file, or the finding's line, or any line of its range, is one the candidate added or sits beside lines it only removed | `unknown`: the finding names no file, a file the candidate did not touch, a file whose changes Tesota cannot read (binary or a path Git quoted), no line in a file that existed before, or a line outside the change |
| `preexisting` | The candidate neither created the file nor added the line | `unknown` |
| `unknown` | Always; a reviewer may say it cannot tell | |

Tesota records why it changed a claim beside the finding; the result panel
and the assurance journal show it. A finding of unknown origin goes to the
operator, marked `⚠ cause unclear`, and never back to the agent. Evidence
Tesota cannot read never counts as proof either way.

Two differences from RDD are deliberate. Tesota does not split candidate-caused findings into introduced,
behavior-activated and worsened: an unchanged line that the change now reaches
becomes unknown, and the operator can send it back as a request. A range
counts as introduced when any of its lines changed, Codex's overlap rule,
rather than RDD's containment; ranges come only from Tesota's own ClaimCheck
findings, whose lines Tesota computes from the contract.

### 2. Reviewers read numbered lines

The diff Tesota gives the reviewer and the fix validator carries each
candidate line's number in a left column, and the finding's `line` asks for
the changed line that causes the problem. This removes the counting that
misplaced findings, instead of widening the rule to tolerate it.

### 3. A deep review says what it will run and what such reviews cost here

Before a deep review, Tesota writes one line: which sessions run, the reviewer
and its lenses, ClaimCheck when contracts were proved, the fix check in a
correction round, and the refuter; and the median duration and tokens of
comparable reviews of this repository, the same depth and the same kind of
round, or that fewer than three have been measured. The review's summary then
shows what it took.

A measurement covers the whole review step, from the first reviewer to the
refuter: wall-clock time and every token the provider reported through Pi,
cached input included. Tesota keeps the latest twenty per repository with its
approved checks, and only from steps in which every reviewer finished. The
forecast asks nothing. Depth is computed from facts, correction rounds must
not stall unattended, the operator's subscription is not billed per review,
and `Ctrl+C` stops a review at any time. Standard reviews, one reviewer and
the refuter, are not forecast.

## Delivery

1. Origin checked against the diff, `unknown` origin shown to the operator
   and kept out of correction, numbered diffs for the reviewer and the fix
   validator, and contract lines for ClaimCheck findings. The rule itself is
   `checkedOrigin` in `src/verification/finding-origin-rule.ts`, with
   LemmaScript specifications taken from the table above and proved with
   Dafny by `bun run formal:check`. Measured on 2026-09-25 with three
   `bun run live:review` runs after numbering, two at computed depth with
   corrections and one forced deep: no introduced finding outside the change,
   against 21 of 135 before. Recall was 4, 4 and 3 of 4 (the `>= 100` miss
   seen before), every planted false claim was refuted, and fix validation
   behaved as before. One finding became unknown: a reviewer called the
   weakened test "already there" on a line the change added, which decision
   016 would have shown as background.
2. Token counting for every review session, the per-repository measurements,
   the forecast line before a deep review and the cost in its summary; the
   evaluation also records each case's tokens, 2k to 29k per case for the
   reviewers and the refuter in those runs. Whether there are enough
   measurements to estimate, and which sorted positions are the middle, are
   `canEstimate` and `middlePositions` in `src/verification/review-estimate.ts`,
   proved by `bun run formal:check`; averaging the middle two stays in plain
   code, because LemmaScript models `number` as an integer.

## Consequences

- A reviewer that places a finding outside the change now reaches the
  operator instead of the agent; correction rounds act only on findings the
  diff supports.
- A repository has no forecast until three comparable reviews finish;
  forecasts are medians of that repository's recent reviews, not guarantees.
- Token counts are what the provider reports; cached input is counted as
  reported, so a count is not a bill.

## Rejected alternatives

- **Trusting the reviewer's origin (decision 016 as it was).** Nothing checked
  the claim that decides whether the agent changes code.
- **Tolerating a few lines around the change.** It would hide the cause,
  reviewers counting lines, and weaken what "introduced" proves.
- **Behavior-activated and worsened now.** Supporting them needs evidence that
  the change reaches the unchanged line, which the diff does not give; unknown
  already routes them to the operator.
- **A consent prompt before deep review.** It would stall unattended correction
  rounds for a cost the operator's subscription already covers.
- **Forecasting from the evaluation set.** Its eight small candidates say
  little about the operator's repository.
