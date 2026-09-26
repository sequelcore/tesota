# 016: Make review findings precise enough to act on

Status: adopted 2026-09-25. Extends the review role of
[decision 015](015-assurance-around-the-agent-loop.md). Evidence is in the
[agent review landscape](../references/agent-review-landscape.md). Adapts ideas
from Gentle AI's RDD (MIT) with attribution; it does not use Gentle AI's
code or protocol.

## Context

Tesota's reviewer reports every problem it believes, and fixable ones go
back to the agent. That works on seeded defects, but current practice and
research agree it is not precise enough to act on unattended. Model reviewers
flag pre-existing problems, speculate, and judge correct code non-conformant
more often than the reverse; prompts that demand explanations and fixes make
that worse. A false finding is costly in Tesota specifically: it drives a
correction round that changes code nobody asked to change. Codex, Anthropic
and Gentle AI count only problems the change introduced; Anthropic and Gentle
AI try to disprove each finding before admitting it; Refute-or-Promote shows
that model agreement can endorse a non-existent bug that one test disproves.
Tesota's correction rounds also re-review the whole candidate, so each round
can raise new findings instead of converging.

## Decision

### 1. A finding has three independent dimensions

| Dimension | Values | Set by |
| --- | --- | --- |
| Disposition | `fixable`: a defect against the request the agent can fix; `operator`: needs the operator's judgment | The reviewer |
| Origin | `introduced` by this candidate; `preexisting` | The reviewer, who must name the provably affected code for an introduced problem outside the diff |
| Standing | `confirmed`, `refuted`, or `unsettled` | Tesota, from refutation; never the reviewer |

Only a finding that is fixable, introduced and confirmed goes back to the
agent. Pre-existing findings are shown to the operator as context and never
start a correction. Refuted findings stay in the assurance journal and are
counted, not listed, in the review. Unsettled findings are shown as unsettled.

### 2. Every finding faces a refuter

After the reviewers finish, Tesota starts one refuter session per review:
read-only file tools, no shell, and a mandate to disprove each finding. It
starts cold: it sees the request record, the diff, the verifier results and
each finding's statement, location and reason, but not the reviewer's
session. For each finding it returns `confirmed` with the code or check
output that shows the problem, `refuted` with what shows it is not one, or
`undetermined`. A finding the refuter does not answer, or answers
`undetermined`, is unsettled. A refuter that does not finish leaves every
finding unsettled; it never confirms or clears one by omission. Verifier
failures are already executable evidence and are not refuted.

### 3. Depth follows facts Tesota computes

Tesota, not a model, chooses the review depth from the frozen candidate and
shows the reasons:

- **Standard**: the request-conformance reviewer, then the refuter.
- **Deep**: also focused lenses in parallel, then one refuter over all their
  findings, when the candidate touches security- or authority-sensitive
  paths, changes what checks it (decision 015's flags), has a failed
  verifier, or exceeds a size threshold. The first lenses are correctness and
  regressions, security and authority, and the repository's own rules from
  `AGENTS.md` or `CLAUDE.md`, cited by line as Codex requires.

### 4. Correction rounds converge

After a correction, Tesota runs every verifier on the new candidate, asks a
read-only fix validator whether each finding sent back is resolved, and
reviews only the correction's own diff, from the previous candidate's tree to
the new one, with its findings refuted as usual. Unresolved findings carry
forward; the round limit and stopping rules of decision 015 are unchanged.

### 5. The review is measured

An evaluation set of frozen candidates with known truth runs live before a
change to review is adopted: seeded defects (a boundary mistake, a weakened
test, a missed requirement, an authority flaw on a sensitive path), a
pre-existing bug the change does not touch, and correct controls. It reports
confirmed true defects, confirmed false findings, unsettled findings, and time.
Results go to [findings](../findings.md); a change that lowers precision is
not adopted.

## Delivery

1. Origin in the reviewer's contract, and only introduced findings starting
   corrections.
2. The refuter and finding standing.
3. The evaluation set, run before and after the refuter.
4. Delta review and fix validation in correction rounds.
5. Computed depth and the first lenses. Measured on 2026-09-25: forced deep
   review found the same planted defects as standard review with no false
   positives, but showed up to twice as many findings, because the refuter
   merged only some duplicates between lenses. Lenses run only when depth is
   deep. Tesota then grouped findings at the same file and nearby lines for
   the refuter, which decides whether each group is one problem, and accepts
   a duplicate only within one file: deep runs showed 5 and 10 findings with
   9 and 5 merged, including the authorization finding the refuter had left
   repeated before. Duplicates across files stay, by design.
6. Executable probes, where the refuter writes a check that demonstrates a
   finding and runs it in the sandbox on a copy of the candidate: after the
   evaluation set shows which findings remain unsettled.

## Consequences

- Each review makes at least one more model call, the refuter, and a deep
  review several more; depth keeps that cost to candidates whose facts call
  for it.
- Findings the operator sees are fewer and more likely real; some real
  problems will be refuted wrongly, and the journal keeps them.
- The refuter uses the same model route as the reviewer, so cross-family
  review, which Refute-or-Promote uses against correlated blind spots, waits
  for a second route or an independent reviewer.

## Rejected alternatives

- **Majority voting over repeated passes.** Bugbot moved from it to an
  agentic reviewer that investigates with tools, and Refute-or-Promote shows
  agreement can be unanimous and wrong.
- **A numeric confidence threshold.** The reviewer grades its own certainty;
  Anthropic's plugin moved from a score threshold to a separate validation
  pass.
- **Letting the reviewer decide depth.** The depth that determines scrutiny
  must come from facts the agent cannot talk down.
- **Re-reviewing the whole candidate after each correction.** It can raise
  new findings every round instead of settling the ones sent back.
- **Integrating Gentle AI's review now.** Its protocol admits Pi only through
  the gentle-pi host (see decision 015); the ideas are adopted instead.
