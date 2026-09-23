# General-purpose harness implementation plan

Status: proposed on 2026-09-23. The [roadmap](roadmap.md) owns priority and
capability status; this page owns the implementation sequence and completion
signals. Revise a later slice when a selected task or repository invalidates
its premise. Passing a component test does not establish user usefulness.

## Intended result and boundaries

A person can give Tesota ordinary work, understand the proposed access, inspect
the actual result and applicable checks, correct failures, and decide what to
accept. It should be useful with its own shell. A verifier reports a bounded
claim; a reviewer assesses the result and evidence fit; human acceptance and
application remain separate.

Do not create a universal agent, verifier, plugin or hosted-service framework
to start. Tesota has no external consumers today, so obsolete internal
TypeScript task branches can be removed when their supported behavior has a
replacement. Preserve legal notices, historical decisions and experiment
records. A future application consumer supplies its own identity and domain
policy; no private product detail belongs in this public plan.

The shell appearance is part of the first user workflow. The historical
`kiln-legacy-2026-09` tag contains Tesota light/dark palettes and a TUI
adapter; use their semantic colors as design reference, not their GUI, gateway
or configuration architecture. Establish a small set of shell-owned roles
for text, emphasis, focus, checks, warnings and diffs. State and decision
labels must remain legible without color. Session-only theme selection is
implemented as an early preview; qualify it through the first user workflow.
After that, qualify one user-supplied palette through the same roles;
appearance cannot change work authority or evidence meaning.

Before implementing a slice, freeze a small task and its expected outcome,
source baseline, required effects, applicable checks and independent assessment.
Keep refusals, failed attempts, setup time, user intervention, review effort and
residual defects. A successful demonstration qualifies only the task and
environment exercised.

Slice 1 establishes the first shared work and evidence path. Slices 2 and 3
depend on it, but do not depend on each other. Later file operations and
language adapters enter only through tasks that need them. An application-hosted
proof may start once a concrete consumer and the relevant lifecycle contracts
exist; Java, new-file creation and dirty-input support are not blanket
prerequisites. The numbered order guides attention rather than requiring
unrelated capabilities to ship first.

## Shell workspace delivery alongside slice 1

The shell must let a person return to a conversation, inspect the result under
review and supervise another session without sending a decision to the wrong
one. A session is the user-visible conversation. A task is one bounded request
inside it. A check or human decision belongs to a particular result, not to
the session as a whole. Activity, pending human input, unread output and stale
evidence remain independent facts.

1. **One selected session and real inspection.** Put the composer and status
   below the selected conversation. Show structured proposal, answer and review
   information in an inspector; keep a summary in the conversation and show the
   actual diff as text. Narrow terminals must expose the same information with
   keyboard controls. Done when a supported task can be inspected and decided
   with keyboard alone at narrow and wide sizes, including stale or missing
   evidence. The layout and typed presentation callbacks are implemented;
   narrow-terminal live inspection was exercised; wide and stale-evidence
   visual qualification remains pending.
2. **Several sessions without crossed input.** Give each session its own
   transcript, draft, request for human input, progress and cancellation. The
   left list contains sessions; reviewer and verifier activity stays with its
   task. Done when A can request a decision while B is selected, and only A can
   receive that decision. The session-owned terminal state is implemented;
   a live session kept its approval target while another answered. Live
   cancellation isolation remains pending.
3. **Durable history and guarded continuation.** Persist the human transcript
   separately from task outcomes. Use Pi's own session record for settled model
   context and retain cumulative usage counters; interrupted work starts with
   fresh engine context, never recovered authority. Unconfirmed effects block
   further work in that session. Done when a normal restart restores useful
   context and results, an interrupted restart does not revive a grant, and
   corrupt storage fails visibly. Automated cases cover settled Pi context,
   local history and interrupted-state reconstruction; normal restart was
   exercised live, while interrupted restart remains pending. A changed
   repository baseline refreshes the model context
   and rechecks the request, carrying forward the consumed budget; a changed
   baseline during clarification still stops that continuation.
4. **Two independent operations.** Bind model context, prompts and cancellation
   to the originating session. Serialize application to the same repository so
   a second acceptance sees the first write and must pass source-drift checks.
   Done when two genuine tasks progress, cancellation affects only its target,
   and overlapping application cannot overwrite a peer's result. The bounded
   composition is implemented; concurrent live task qualification is pending.
5. **Optional simultaneous view.** A wide terminal may show a second session
   read-only beside the selected conversation, with one explicit input target.
   Done when switching, resizing and leaving split view cannot retarget a
   pending decision. The view and keyboard toggle are implemented; live visual
   qualification is pending.

These are shell increments within the existing task roadmap. They do not make
Go, document work or community methods depend on a window manager. No general
agent scheduler, event bus or new authority type is implied by the layout.

## 1. One complete TypeScript fix with independently selected checks

**Outcome.** Through the ordinary shell, fix a preselected bug involving one
existing source file and one existing regression test. Tesota runs both the
qualified targeted Node test and qualified contained TypeScript typecheck for
the same final result, then presents a readable diff and separate claims.

**Owners.** `task-proposal-contract.ts` currently chooses checks from file
paths; `proposal-admission.ts` and `task-contract.ts` bind task kinds and
check tuples; `candidate-task.ts`, `integrations/pi-task.ts`,
`task-review.ts` and `task-start.ts` run and present them. Reuse the existing
Node and TypeScript adapters and container settlement. The shell selects from
eligible, already qualified adapters before approval. Admission captures each
adapter ID, bounded options, requiredness, configuration identity and material
inputs in the grant. Scope integrity remains mandatory. Repository text and
model output cannot authorize execution fields, add a command or weaken a
selected check by themselves.

**Done when.** The original defect fails the same regression oracle that later
passes on the repaired result, without weakened assertions. Both required
checks pass on that final result, and the user can accept and apply
or reject it without internal IDs, raw hashes or escaped JSON. The shell
makes the work, check outcomes and next human decision scannable in narrow
and wide terminals, including a readable monochrome rendering. A failed,
missing, malformed or interrupted required check never appears as a pass.
Candidate edits, changed check inputs and source drift invalidate evidence or
application as appropriate. Correction receives fresh checks. Record one fresh
ordinary task, including the user's decision and independent residual-defect
assessment. Existing supported outcomes continue to work. Remove superseded
task-kind/check-selection paths rather than retaining aliases.

**Recovery.** Retain the candidate and observed failure. An unconfirmed process
or source write remains uncertain and cannot be replayed as if it had settled.

**Current evidence (2026-09-23).** Check selection and exact-result composition
are implemented and covered by component tests. A fresh ordinary-shell attempt
selected both checks and established a failing regression, but its execution
remained unconfirmed before a final check and human review. Independent review
also found that its candidate broke a retained formal-check path. The
[attempt record](../experiments/practical-use/2026-09-23-combined-check-results.md)
is a failed qualification, so this slice remains open. The next attempt needs
a task whose existing verification contracts can be preserved, a confirmed
final check, an explicit human decision and independent residual-defect review.

## 2. One useful task outside a code repository

**Outcome.** Answer a prospectively selected question over supplied local
material, with traceable source locations, limitations and a correction path.
Select one real document format and task before choosing an extractor. This
slice must end naturally in an answer; it has no file-application ceremony.

**Owners.** The current `conversation-turn-contract.ts`,
`conversation-turn.ts`, `integrations/pi-discovery-session.ts` and shell
composition own the nearest conversational path. Add a document input and
answer-evidence owner only for the selected task. Admit the exact read scope
and stable source snapshots before the agent uses them. Do not route an answer
through `task-promotion.ts`.

**Done when.** The user can provide the selected material, ask the question,
inspect the answer's source locations and remaining uncertainty, request a
correction and receive a newly identified result. Source changes, missing
pages/sections or cells, contradictory passages, instruction-like input and
cancellation have honest outcomes. Instructions inside source material cannot
expand file or tool authority. Mechanical extraction or citation checks
do not claim the conclusion is correct; independent review assesses that.
Retain one ordinary user walkthrough and its effort and error record.

**Recovery.** Recorded source identity, answer and limitations remain
inspectable; a changed source cannot make an old answer appear current.

## 3. One Go repository fix

**Outcome.** Complete a preselected existing-file Go bug fix with its actual
targeted test through the same shell. This tests whether work, check selection
and review are independent of TypeScript, without claiming general Go support.

**Owners.** Extend proposal admission, task execution and Pi tool composition
through their current owners. Add one Go check adapter only for the selected
repository. Reuse container/process settlement only where its policy fits.

**Done when.** The original bug fails, the corrected result passes the admitted
test, toolchain and dependency identity are recorded, changed inputs make the
evidence stale, and unexpected file or process effects fail visibly. Missing
offline dependencies are an explicit setup outcome; Tesota does not silently
download or run a weaker host command. Review and application detect source
drift. Retain a fresh repository walkthrough and independent assessment.

**Recovery.** Failed or unsettled execution retains its candidate and observed
state; uncertain descendants block a success claim.

## 4. One community-supplied verification or review method

**Outcome.** A contributor supplies one method for a selected real task
without changing Tesota's core task policy. Choose whether the first method
is a verifier or reviewer from that task; qualify the other role separately
when a consumer needs it.

**Owners.** Current verification adapters, `gentle-review-host.ts`,
`task-review.ts`, check-input and process settlement are existing examples,
not a universal plugin contract. Add a small admission and result boundary
only for the supplied method. Extract common evidence fields from implemented
consumers while retaining method-specific claims and effects.

**Done when.** Someone outside the implementation can install, configure,
test and remove the method from documented instructions. Its producer,
configuration, examined inputs, claim, outcome and limits are visible and
bound to the result. Malformed, empty, incomplete, unavailable and stale
reports do not become passes. A reviewer may identify an intent gap or request
more work but cannot accept or apply the result. Retain a fresh user task and
contributor walkthrough without author assistance.

**Recovery.** An unavailable optional method leaves its claim unestablished;
an unavailable required method blocks the adopted completion condition.

## 5. One feature that creates a file

**Outcome.** Complete a selected small feature that genuinely requires one
new regular file. Do not add deletion or renaming until a selected task needs
them.

**Owners.** `candidate-checkout.ts`, `candidate-task.ts`, `task-source.ts`,
`task-review.ts`, `task-promotion.ts` and `task-outcome.ts` currently assume
existing committed files and replacement. The new operation must span
proposal, grant, candidate effect, check, exact review and application.

**Done when.** The user approves the new path, the result is checked and
reviewed, and application creates only that exact file if it is still absent.
Path or case collision, symlink substitution, parent-directory change,
concurrent user creation and interrupted multi-file application preserve an
accurate outcome. Rejection leaves the source unchanged. No automatic rollback
claim is made across uncertain or partially applied effects.

## 6. One task that uses current working-tree input

**Outcome.** Complete a selected task that depends on an uncommitted user edit,
without discarding or overwriting unrelated staged or unstaged work.

**Owners.** `repository-discovery.ts` and `candidate-checkout.ts` currently
observe a committed baseline; `task-source.ts` binds existing targets to
committed content; `task-promotion.ts` guards final writes. Admit exact
working-tree inputs through those owners instead of pretending they are Git
blobs.

**Done when.** The user can see which current edits are inputs, the candidate
uses those exact bytes, relevant changes invalidate checks, and a concurrent
edit prevents unsafe application. Unrelated user work survives accepted,
rejected, failed and cancelled runs. Stash or reset is not used as an invisible
shortcut. Retain a live task and source-drift case.

## 7. One Java repository task

**Outcome.** Complete one selected Java task with the repository's actual
Maven or Gradle check. Choose the build system from the task; do not implement
both in advance.

**Owners.** Current admission, check-input, process settlement, review and
shell owners gain a concrete consumer. Add a dedicated adapter for its
tool-specific semantics. Reuse shared evidence fields only where implemented
methods need the same meaning.

**Done when.** The Java check has bounded effects and binds its toolchain,
dependencies, configuration, inputs and result. Build plugins and subprocesses
are qualified in the actual environment. Malformed, empty, incomplete,
unavailable and stale reports do not become passes. The corrected result
passes its admitted behavioral check and remains subject to human review and
guarded application. Retain a fresh repository task and independent assessment.

**Recovery.** An unavailable required check blocks the adopted completion
condition; an uncertain descendant blocks a successful settlement claim.

## 8. One application-hosted task without external effects

**Outcome.** A synthetic application invokes a bounded Tesota task and
receives a result and evidence. Start only when a concrete application
consumer can exercise the boundary; no generic hosting platform is a
prerequisite.

**Owners.** The application owns identity, domain data, current objective and
action eligibility. Tesota owns admitted execution, evidence and settlement.
Select the integration entry point from the actual consumer; do not duplicate
the interactive shell's UI or import application policy into Tesota.

**Done when.** The host supplies scoped context and receives an inspectable
result and evidence. Cross-tenant requests are rejected; cancellation and
unknown settlement retain honest outcomes. A changed objective makes prior
evidence or approval inapplicable. The consuming application can review the
result without any customer-facing effect. Private migration, customer and
deployment evidence stays with that application.

## 9. One consequential application-hosted action

**Outcome.** The same concrete consumer admits one action with observable
effects. This slice depends on slice 8 and a named action owner, not on Java,
new-file creation or dirty repository input.

**Owners.** The application owns the business decision and commits the
effect. Tesota binds the admitted task, tool request and resulting evidence to
the supplied authority. The effect owner enforces current authority when the
effect commits; a prior read alone cannot close the race with revocation.

**Done when.** Changed objectives and revoked permissions stop stale actions
before their effects. Cross-tenant attempts are rejected, retries do not
duplicate the action, and lost acknowledgement yields uncertainty and
reconciliation instead of blind replay. Human handoff and the final outcome
remain reconstructable without restoring expired authority. Production
deployment and migration require separate private qualification.

## Release and scope gates

Each slice updates [Using Tesota](using-tesota.md) for what users can actually
do, [qualification](qualification.md) for its claim, and the
[roadmap](roadmap.md) for status. Focused deterministic, process and live
evidence are reported separately. Run `bun run check` and
`git diff --check` for source changes. Publish a small reproducible example
when a method or task class becomes usable by others.

Browser/computer effects, external research and additional document formats
remain selected-task extensions. Each needs its own authority, source/state
identity, observed effects and independent assessment before Tesota claims it.
Do not turn those names into empty subsystems or claim that one early example
qualifies the whole category.
