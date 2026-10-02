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

A **candidate** is a turn's changes in the project, or a workspace's pending
changes, identified by their Git tree, together with the operator's
**request record** ([workspace](workspace.md)).
Every verifier and reviewer result names the tree it describes; a changed tree
needs new results.

Tesota flags, with fixed rules, changes to tests, check or lint
configuration, CI workflows, formal specifications, package scripts and its
own setup. Flags go to the reviewers and to the operator, marked !: a flagged
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

**A check may have a related form** (decision 052), typed after it as
`command; related: other {files}`, where Tesota puts the candidate's changed
files, each quoted as one shell word. A round runs the related form in the
command's place only when the candidate changed files, deletes none, whose
dependents a related form cannot find from a path that is gone, does not
change what checks it, and the round can still send work back
(`runsRelatedForm` in `src/verification/check-scope-rule.ts`, proved by
`bun run formal:check`). Its claim is that the tests the command relates to
the changed files pass, never that the command passes. A related form's
failure is judged by the whole command on the base, so a new test missing
there cannot make it `preexisting`. Every way a round can end the work, a
clean review, the operator's queued message or a correction that changed
nothing, first runs the whole commands when the round ran only related forms
(`owesWholeCommand`); the result panel then shows them, the journal records
them as a `checks` entry, and a failure that comes with the candidate goes
back to the agent while a round remains.

**A failing check runs again on the base**, as a commit queue
retries a failure without the patch: Chromium's CQ fails a change only for
tests that fail with it and pass without it. When a check command fails or
times out on the candidate, Tesota runs it again, in the same environment, on
the candidate's base. A workspace pins the candidate's tree to a ref,
switches the checkout's tracked files to the base with `git read-tree --reset
-u`, which leaves ignored files such as installed dependencies in place, runs
the command, and restores the candidate, removing anything the run added;
reopening a workspace restores a candidate a stopped run left pinned. A
session working in the source never touches the operator's files: it fetches
the tree before the turn from the shadow repository into a one-commit
checkout of its own, with the operator's line endings, and the WSL sandbox
mounts that checkout at the source's path for the run, with the same
`node_modules`, so the command sees the same paths (`RunOptions.root`); the
checkout is removed afterwards. An environment that cannot show another
folder there, a command on the operator's computer or Docker Sandboxes,
leaves the base run not started and the origin `unknown`. The
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

**Sensitive paths** (decision 053) come first from what the repository and
the operator declare:
`.tesota/sensitive-paths` lists globs, one per line, as GitHub's CODEOWNERS
and Chromium's OWNERS name what needs a qualified reviewer. Tesota reads the
file as the candidate's base holds it, as GitHub takes CODEOWNERS from the
base branch, so a change cannot drop its own paths, and a change to the file
is flagged as Tesota setup and reviewed deeply. A repository without the
file is not left to guess: before its first review Tesota proposes a list,
the files outside the tests whose names or imports mark them, and the
operator accepts it with Enter, removes globs with `-glob`, adds others, or
answers `none`, once per repository, beside the checks; `/checks` shows the
list and `/checks reset` asks again. `tesota run`, with nobody to ask, keeps
the proposal. Developers mostly keep a security tool's defaults: in a survey
of 1,263, 54% of those who used static analysis tools had not configured them
([Bennett et al., 2024](https://doi.org/10.1145/3674805.3690750)), so a
declaration nobody is asked for would mostly not exist; Renovate onboards a
repository the same way, with a proposed configuration to accept, and
GitHub's code scanning detects what to scan before anyone configures it. A
declared or confirmed path counts whatever it is, a test included. Beyond
the list, a path's name counts, but only by terms that cannot mean anything else, such as auth,
credentials, crypto or migrations, plus infrastructure files such as a
Dockerfile. Terms that also name ordinary things, token, session and access,
count only as a whole folder or file name: `src/session/` and `tokens.ts`
do, `session-title.ts` and `token-usage.ts` do not. Until the operator
confirms a list or the repository declares one, code that imports process,
cryptography or network APIs counts too, on either side of the change, so a
repository nobody configured leans toward the thorough review. A test file
never counts by name or imports, since changing an existing test is a reason
of its own
(`sensitivePath` in `src/verification/sensitive-path-rule.ts`, proved by
`bun run formal:check`). Names guess in both directions: on Tesota's own
history the name rule alone missed its command rules, egress proxy and
sandboxes, and caught usage formatting and session titles. On Tesota, the
proposal finds 11 of the 23 files its own declaration names, where names
alone found 5; the rest are pure decision rules, such as its command and
approval rules, which no name or import reveals, which is why the operator
confirms the list rather than Tesota deciding it. Meta's RADAR orders its gates the same way, the
repository's and the change's metadata before any model score.

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

The operator sees ✗ for a confirmed fixable defect the change introduced, !
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

**A message that only steers is no request of its own.** Each message is
recorded verbatim, but "continue" after a stopped turn, "try again", or "ask
again" after a declined command asks for nothing new. The reviewer lists such
a message as a **continuation** of the earlier request, gives it no
obligations, and judges that request together with it, so anything it adds
becomes part of that request; when unsure, it attaches the message too, which
changes only the count. An attachment stands only to an earlier request that
exists and when the message has no obligations of its own
(`continuationAccepted` in `src/verification/continuation-rule.ts`, proved);
otherwise the message is a request to assess. In the session that showed
the problem, "continue i stopped by accident" and "ask again" made one piece
of work read "1 of 3 done, 2 unclear"
([#253](https://github.com/sequelcore/tesota/issues/253)). `live:answer`
scores how many requests each verdict counts on cases registered for it.

Every **gap**, a partial or unmet obligation, faces the refuter with the
findings, numbered after them. An obligation **held** when the reviewer
found it met or the refuter disproved its gap, **did not hold** only when the
refuter confirmed the gap, and is **uncertain** otherwise, including a gap
nobody tested or settled; that rule is `obligationOutcome` in
`src/verification/obligation-outcome.ts`, proved by `bun run formal:check`.
An obligation that did not hold goes back to the agent only when the agent
can satisfy it: the reviewer gives a partial or unmet obligation a
disposition, as it gives a finding, and one the agent cannot satisfy within
the request, such as "the tests must pass" when a test also fails on the base
because the environment lacks a program, goes to the operator, with no
correction round (`obligationAction` in
`src/verification/review-action-rule.ts`, proved). The first dogfooding
session spent both its correction rounds on such a request.
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
The verdict is never silent: the conversation records it as its own entry,
with the triage model and its reason, as checked, skipped or undecided
(`triageOutcome`, proved to say skipped exactly when the full check does not
run), and `/verify` runs the full check on a skipped answer until the next
turn. Every review report records the model that wrote it, and the refuter's
when it tested that report's findings or obligations
(`src/review-attribution.ts`); the record and the line under each review
name them, and the status line names each step's role and model, so who
verified a turn is part of its evidence.
The first pass takes about two seconds; the full check is one reviewer
session, and the refuter's when there are gaps. This is the discretionary
review triage issue #124 asked a consumer for. The `triage` role may instead
use Jev, the typed decision model that issue proposes:
`typesafe:jev-1.13.0`, with the operator's TypeSafe key, answers in about a
tenth of a second (`src/integrations/jev-triage.ts`). It asks two questions
in parallel: what the requests ask for, a change or run, information about
the repository, or conversation, from the requests alone, so the agent's
wording cannot talk a request out of its check; and whether the reply states
something checkable. A turn is skipped only when both fall below 0.2, the
threshold registered with the first pass's cases before any model saw them
(`turnCheckable`, proved beside `runsAnswerCheck`). A refusal, an error, a
missing key or no answer within ten seconds decide nothing, so the full
check runs. The version is
pinned: a newer one is offered only once it has been measured on those
cases. TypeSafe receives the turn's requests and reply, and says it does not
train on them.
Every first pass is journaled, a skip included, with its model, decision,
probability when the model gives one, whether the full check ran and the
turn's tool calls; the result panel shows why a checked turn was checked.

The answer reviewer and the refuter also receive Tesota's record of the
latest turn's tool calls, each with its outcome: succeeded, failed or
unfinished. A claim in the reply that the agent read, ran, checked or changed
something holds only when that record shows it, since agents report work
their own transcript shows they did not do
([Smyth et al., 2026](https://arxiv.org/abs/2609.20812)).

### Planned: routing the answer check

The first pass answers one yes-or-no question for the whole turn, from the
requests and the agent's reply. Two weaknesses follow. The reply sets the
outcome: a greeting answered with a remark about modified files scored 0.75
checkable, and the same greeting with a plain reply 0.09. Judges that read
only an agent's final message also detect false completion claims poorly,
at most AUROC 0.65 against 0.83 to 0.95 for detectors that read state
([Advani, 2026](https://arxiv.org/abs/2606.09863)); action classifiers
withhold the agent's own prose for that reason
([Anthropic, 2026](https://www.anthropic.com/engineering/claude-code-auto-mode)).

The planned first pass separates what a turn holds and sends each part to
the cheapest check that can settle it:

| Part | Evidence | Settled by |
| --- | --- | --- |
| A request to change or run something, or a follow-up to one | Repository and the turn's events | Full check: obligations and refuter |
| A question about the repository | Repository | Reviewer |
| A reply claim about the agent's own actions: read, ran, changed | The turn's tool calls | Reviewer given the record (built) |
| A reply claim about the workspace | The workspace record | Comparison with the record, no model |
| A reply claim about the repository | Repository | Reviewer |
| A reply claim about runtime behavior | Session records or execution | Reviewer given those records, else reported unverified |
| Conversation | None | Nothing |

The request's kind is decided from the requests alone, as the Jev first
pass now does; the reply's claims are extracted and classified separately, as in claim-level verification
([Wei et al., 2024](https://arxiv.org/abs/2403.18802)). Claims in free prose,
in any language, are not extracted by rules: the evidence is Tesota's own
record, and the comparison is made by a model. A typed decision model
can answer both as choice questions in one call. Routed parts share one
reviewer call per turn, because a gate per part compounds false positives
([Jotautaitė et al., 2026](https://arxiv.org/abs/2605.09684)). A step that
fails or does not decide falls back to the full check, and
`runsAnswerCheck` and its proof extend to each route. The router replaces the
yes-or-no pass only if, on registered cases drawn from journaled turns, it
skips nothing the current pass checks and costs less.

### The request's premise

Obligations judge whether a request was done, not whether it should have
been. A request that calls documented behavior a bug is met by changing that
behavior: the reviewer marks the obligation met and nothing reaches the
operator, although the premise, not the code, was wrong. Projects that triage
reports from strangers check the premise before any fix. oh-my-pi's issue bot
accepts a bug only when it breaks a contract, has a demonstrated impact, is
not a deliberate tradeoff, lies in this repository and not upstream, and rests
on claims it verified, and a maintainer's "works as designed" stops it
([`system_append.md`](https://github.com/can1357/oh-my-pi/blob/9b9886514600f0b7b2d9afe83df46ee854e3d826/python/robomp/src/prompts/system_append.md)).
Hermes Agent's contribution rubric names a wrong premise and intentional
design mistaken for a gap as the most common reasons a well-written pull
request is closed
([`AGENTS.md`](https://github.com/NousResearch/hermes-agent/blob/9cbc6a5ac0e92423151e61f913d21904efafe0c1/AGENTS.md)).

Measurement comes first. `live:agent --set=premise` and `live:review
--set=premise` hold four false premises and a control, registered before any
run ([evaluation method](../development.md#evaluations)): behavior a policy
document and a test call intended, a function that does not exist, a defect
in a vendored copy the repository must not edit, and a symptom the base does
not show. The control makes the same report as the intended case against a
policy the code breaks, so declining every report does not score as right.
The baseline on 2026-09-30, on `codex:gpt-6-luna` and `claude-code:haiku`,
shows the gap. The agent left alone 1 of 16 false premises; on the
documented policy it named the policy in its reply every time and changed it
anyway, and it worked around the vendored defect in the repository's own code
in three of four runs and edited the vendored copy in the fourth. The review judged every false-premise
request met. Only the documented policy drew a finding, on both models, and
the refuter disproved it each time because the request states which behavior
should change: it read the report as an authority over the documentation, not
as a claim to check against it. On `claude-code:haiku` the main reviewer also
reported the comment the change left stale as fixable, which would have sent
the agent back to make the comment agree with the change. Both refuted the
control's planted claim and raised nothing against its fix. The answer check
had the same gap from the other side: given a turn in which the agent rightly
declined a request about a function that does not exist, it judged the
request unmet and sent it back every time, on both models, pushing the agent
toward the change it was right to refuse.

**What the review does now.** The main reviewer checks each request's
premise as well as whether it was done: that the behavior called a bug is not
documented or tested as intended, that the named code exists, that the defect
is not in vendored or third-party code the repository says not to edit, and
that the base does not already behave as asked. A false premise is one
finding marked `premise`, on the change that follows it, quoting what shows
it false; a document, comment or test that disagrees with the change only
because the change follows the premise is that finding's evidence, not a
defect of its own, and the request's obligation is `uncertain` rather than
partial or unmet. Every reviewer, focused lenses included, is told that a
change contradicting documented or tested behavior because a request asked
for it questions the premise, not the change. Tesota makes a premise finding `operator` whatever
disposition the reviewer gave it (`src/integrations/pi-reviewer.ts`), so the
proved `findingAction` never sends it back: confirmed or unsettled, it needs
the operator, who alone can say that documented behavior should change after
all; refuted, it is context. The refuter is told what the baseline showed it
assumed: a request that reports a bug is the user's claim about the
repository, to be checked against its documents, tests and history, and a
dispute is not refuted because the request asks for the change. In a turn
that changed no files, the reviewer marks a rightly declined false premise
`uncertain` rather than `unmet`, so the request waits for the operator
instead of going back to the agent. The result panel labels a premise
finding "your call, the request's premise". The first pass does not take
this on, since settling a premise needs the repository and the first pass
reads only the requests.

**Measured** on 2026-09-30 with the premise cases and the answer case
registered before any run, each model filling the reviewer, refuter and
validator roles. After refutation, false premises marked for the operator
went from 0 of 6 to 5 of 12 on `codex:gpt-6-luna` (four runs) and from 0 of 6
to 2 of 3 on `claude-code:haiku` (one run), and no premise finding was sent
back; before, `codex:gpt-6-luna` sent one back. The score counts a finding
only when Tesota could establish that the change caused it, so a premise
finding that names no file reaches the operator without counting. The
control's planted claim was refuted every time and its fix drew nothing. A
first version, which told only the main reviewer, let a focused lens report
the documented policy as a defect to fix and the main reviewer mark the
vendored request partial, and both went back to the agent on
`claude-code:haiku`; telling every reviewer, and making such an obligation
`uncertain`, removed both. One false-premise case still sent a finding back
once in twelve: `codex:gpt-6-luna` reported, correctly, that the added guard
turns `-0` into `0`. That model also usually missed the symptom that does not
occur. `live:review`'s core cases on `codex:gpt-6-luna` kept 14 of 15 planted
defects found over three runs, with three false positives, against 5 of 5
and one in the run before, and every planted false claim refuted; the scope
cases marked 5 of 6 extras. `claude-code:haiku`'s core and scope cases were
not measured with the final prompts. `live:answer` over six runs on
`codex:gpt-6-luna` left the declined false premise to the operator six times
of six, against none before (four sent back, two cleared), with 55 of 60
other verdicts right against 53 before; `claude-code:haiku` left it to the
operator twice of two, against sent back twice. Neither the answer prompt
nor its cases changed after that measurement.

The working agent's prompt is unchanged: it acted on 15 of 16 false
premises, and a change to it is measured on its own.

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
a round leaves the tree unchanged. **A request the operator already typed goes
first**: when one is queued, no round starts, the items stay in the review
unsent, and in a workspace the result stays pending, as "keep working" leaves
it. The queued message may be the correction: in 20,574 real sessions, 91% of
the visible resolutions of an agent's mistake were the developer's own
correction ([Tang et al., 2026](https://arxiv.org/abs/2605.29442)). Operator findings, unknown origins, check
failures the base shares or that could not be compared with it, incomplete
reviews and checks that could not run never go back to the agent.

**The base stays fixed through the rounds**. A correction continues the turn
it corrects, and in a workspace it does not bring the operator's newer
repository state in, so
the correction's diff holds only the agent's work; with an update in between,
the operator's own edits would read as the agent's correction. That state
arrives with the operator's next request, which starts a new cycle.

### Planned: review beside the next request

Checks and review still run before the next request, so a queued message
waits for them: in the first recorded sessions a review step took 8 to 49
seconds, and two short questions with two correction rounds held the session
for two minutes. The planned change freezes the candidate's tree in a checkout
of its own, as base checks already do, and runs checks and review there while
the agent takes the next request. A result names its tree, so one whose tree
has moved shows as earlier and never decides a keep or an application, and a
correction goes back only while its tree is current. Two facts stand in the
way: a check on the operator's computer cannot run from another folder, and
review beside work must fit the two operations a shell runs at once. It is
adopted only if, replayed on journaled sessions, it catches as much while
holding the operator less.

## The record

Each session keeps an append-only **assurance journal**, `assurance.jsonl`
beside its record: for every reviewed candidate, the requests, each
verifier's claim, outcome and duration, how long a failing command's base
run took when that round made one, the flags, the depth, each reviewer's findings,
what the review step cost, and the operator's decision; for a turn that
changed no files, the answer check's first pass.

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
`Esc` stops a review at any time.

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

## Planned: verification in proportion to the change

Every candidate runs every approved check command and at least a standard
review, whatever it changed. Dogfooding on 2026-10-01 and 10-02 measured
what that costs: 19 of 22 reviews were deep, a median of 83 s and 144k
tokens each, and 5 of the 11 deep reviews with full records found nothing in
any of their four reviewers. On Tesota, typecheck, build and lint take about
5 s and the tests about seven minutes. On the last 60 commits, the static import
graph links a median of 14.5 of 108 test files to a commit's changed files,
21 s of the 321 s the test files take, though the slow workspace tests are
linked in 40 of the 50 commits that change code, and the four test files
that run the compiled CLI are not linked at all.

Larger systems run fewer tests early and all of them before the change lands:
Meta's predictive selection runs a third of the dependent tests and still
reports over 99.9% of faulty changes
([Machalica et al., 2019](https://arxiv.org/abs/1810.05286)); Develocity runs
relevant tests in early, frequent stages and the remaining ones later, always
runs new, changed and recently flaky tests, and runs everything when it lacks
data. Review scales the same way, but not to zero: Claude Code's review gives
pull requests under 50 lines a lighter pass, and still finds something in 31%
of them.

The first part is built: related tests in each round and the whole command
before the decision, described under Verifiers. Each remaining part is
adopted only when journaled turns show it saves time or tokens without
missing what the full pass finds:

- **Related tests the import graph misses.** A related form selects what its
  runner can see; tests that run the compiled program, and new, changed or
  recently failed tests, could join every related run, as Develocity always
  runs new, changed and recently flaky tests.
- **No related tests for a change with no code.** A round that changes
  only documentation, decided from paths and never from a model, runs no
  related tests and says so; the full command still runs before the
  decision, since a repository's check may read its documentation.
- **Correction rounds review what the round changed.** The fix validator and
  the reviewers read the round's change against the reviewed tree, and report
  only new findings that block the result, as Claude Code's re-review
  convergence does.
- **A light review only for a change with no code.** Any code change keeps at
  least a standard review. A typed decision model may make a review deeper,
  never lighter: the diff is the agent's text.

A step that fails or does not decide runs the full check, as the answer
check's first pass does.

## Planned: contributions from others

Not scheduled: this follows the release and daily use
([roadmap](../roadmap.md)). Once others open pull requests and issues, the
same roles apply to their work. oh-my-pi and Hermes Agent triage their
repositories with agents: oh-my-pi's bot labels each issue, reproduces and
fixes bugs, and ranks contributors' pull requests
([`robomp`](https://github.com/can1357/oh-my-pi/tree/9b9886514600f0b7b2d9afe83df46ee854e3d826/python/robomp)),
and Hermes Agent's sweeper may close a contribution only as implemented on
`main`, not reproducible or incoherent. Both are services driven by GitHub
events. Tesota stays a local harness: the operator starts the work, the
findings stay local, and anything sent to GitHub is an outward action the
operator approves, in the words they approve.

### Reviewing a pull request

A pull request is a candidate: its head is the tree, its base the base, and
its title, body and linked issue the request record. `prbench-review.ts`
already reviews a pull request from its diff and context; a `tesota review`
of a pull request would add what that benchmark leaves out: a checkout of the
head, the repository's approved checks with their run on the base, the flags
and the computed depth. Two things oh-my-pi asks a model to judge, Tesota
already settles with rules: whether a failing check came with the change is
its origin on the base, not the agent's word that it was already there, and
unrequested work is reported as an extra.

oh-my-pi's reviewer ranks each pull request P0 to P3 by its own judgment.
Tesota would instead compute a verdict from the review's facts, as it
computes depth, and prove the rule: ready when nothing is left for the author
or a maintainer and every check passes; needs the author when a confirmed
defect or a failing check came with the change; needs a maintainer when an
item is the operator's call, such as an extra, a flagged change, a disputed
premise or an obligation left uncertain; incomplete when a reviewer did not
finish. Tesota never approves, merges or pushes: it drafts one review that
only comments, and the maintainer sends it.

### Reproducing an issue

An issue is a request without a candidate. The `triage` role decides its
kind (a reported defect, a question or a proposal), as Jev already answers
choice questions. Before any work, Tesota searches the repository's issues
and merged pull requests for the same report and shows what it found as
evidence. A reported defect opens a session in a workspace of its own.

oh-my-pi records a reproduction as the command the agent says it ran. Tesota
can establish it: the fix counts as reproduced only when a test the candidate
adds or changes fails on the base and passes on the candidate. Today a check
runs on the base only when it fails on the candidate; reproduction would also
run a passing check there and compare that test by the check's reports, as
`testOrigin` compares a failure. Tesota proposes closing an issue
only for a reason it can show, as Hermes Agent's sweeper does: the base
already behaves as the issue asks; a reproduction was attempted and did not
fail, with what is missing; or the premise failed, with its evidence. Every
other close is a maintainer's decision.
