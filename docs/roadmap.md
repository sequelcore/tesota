# Roadmap

This page owns product status and priority. Tesota is being built as a
general-purpose agent harness: people bring a task, and it uses appropriate
tools while keeping the result, checks and decisions understandable. This is
the intended experience, not a current capability claim.
[Identity](identity.md) defines the purpose; [qualification](qualification.md)
defines evidence for claims; [experiments](../experiments/README.md) retain
dated results. [Decision 012](decisions/012-general-purpose-harness.md) records
the new direction. The [implementation plan](implementation-plan.md) names
vertical slices and their completion evidence.

## Current status

Tesota is pre-release. Its terminal shell supports bounded questions over a
committed repository and two approved TypeScript task shapes in independent
checkouts. One changes one or two existing non-test `src/` files and runs a
fixed contained typecheck. The other changes one existing source file and one
existing regression test and requires a targeted Node test; when the contained
TypeScript typecheck is eligible, the operator can require it too before
approving the work. Selected verifier inputs are bound to that approval, and
both checks must examine the same final candidate. It shows the
exact diff and applicable evidence, then requires a local decision before
guarded application. One bounded semantic correction is implemented.
Known-settled outcomes return to a new prompt; unconfirmed execution or
application settlement ends the session.

[Ordinary live walkthroughs](../experiments/practical-use/2026-09-23-results.md)
include accepted applications, while a
[three-repository sample](../experiments/practical-use/2026-09-23-cross-repository-results.md)
retains an execution failure. These establish the exercised cases, not
representative usefulness. The earlier
[practical-use pilot](../experiments/practical-use/2026-09-22-results.md)
retains failed and degraded attempts. A
[fresh combined-check attempt](../experiments/practical-use/2026-09-23-combined-check-results.md)
exercised eligibility, selection, approval and a failing regression, but ended
with unconfirmed execution and no application. A later
[internal combined-check diagnostic](../experiments/practical-use/2026-09-23-combined-shell-progress-results.md)
completed red regression, both selected checks, independent review, human
acceptance and guarded application on Windows/Docker, after three retained
failed attempts. Its successful run took about 64 minutes because review,
decision and promotion repeatedly snapshotted dependencies. This does not
complete slice 1 or qualify representative external-repository usefulness.
The [execution and evidence repair](implementation-plan.md#execution-and-evidence-repair-before-another-usefulness-claim)
is next: eliminate redundant verification and qualify a Docker-free code route
before another usefulness claim. In that target design Docker is a selectable
protected provider, not a required installation for Tesota's ordinary use.
An [SRT Windows follow-up](../experiments/isolation/README.md#repository-and-alias-follow-up)
ran a real TypeScript check. A private task fixture constrained its own files,
but a separate host tree with broad inherited permissions remained accessible.
The read default is documented; the host-wide write boundary remains unproved.
SRT is not a selected task provider.

The shell now lists local sessions, persists their human transcript and result
inspections, and can reopen a settled Pi context with its consumed budgets.
Each session owns its prompts, cancellation and model context. Up to two
operations may run at once; application to the same repository is serialized
and still rechecks source drift. A wide terminal can show a second conversation
read-only. An interrupted operation is never resumed as active or authorized;
unconfirmed effects block new work in that session. A
[two-session live walkthrough](../experiments/practical-use/2026-09-23-shell-workspace-results.md)
exercised approval binding, an independent answer, an accepted external issue
fix and normal restart. It also found a stale progress defect, now fixed in
source and focused tests. Wide split view, interrupted restart and overlapping
application remain unqualified live. For a new request,
repository baseline changes refresh engine context and carry the consumed
budget forward; a changed clarification baseline still stops that request.
It has session-only Tesota dark, Tesota light and terminal-color appearances;
the first two assume matching terminal profiles. User-supplied themes and
appearance persistence are not implemented.
General repository changes, uncommitted input, new or deleted files,
arbitrary commands, browser/computer use, document work and general research
are outside the current contract. [Using Tesota](using-tesota.md) describes
current use.

## Delivery sequence

Each increment must complete a real user task through the ordinary shell,
state its allowed effects, retain failures and qualify its exact claim before
scope expands. The workstreams below overlap: verification and review grow
with coding and non-code tasks. This is product priority, not a directory
plan or a promise that every named integration will ship.

### 1. Useful general coding work

Replace the fixed TypeScript task shapes with a flow for a small, preselected
change in an ordinary repository. Start with the file operations and checks
needed by that task, then expand to further languages and layouts. The first
slice must let the user select an eligible, qualified repository check before
approval rather than tying it to a TypeScript task shape. Preserve the
check's exact claim and failure outcome.

The user should describe the goal, approve consequential access, see the
result and checks in plain language, request correction, and decide whether
to apply it without managing internal IDs or raw hashes. Preserve uncommitted
user work and detect conflicts. Exercise fresh tasks in more than one
repository, including a non-TypeScript project, failed checks, refusal,
cancellation, rejection and source drift. Record setup, elapsed time,
operator effort, review burden and independently assessed residual defects.
One accepted application establishes only that case.

### 2. General task tools and a non-code task

Add tools in response to selected work, with explicit read and effect
boundaries. Qualify one complete non-code task early, such as research with
source inspection or a document workflow, through the same conversation and
result review. Browser and computer use need their own observed-state,
permission and settlement contracts. Coding checks and file-application
assumptions do not automatically transfer to another domain.

The shell should explain results, sources, actions, checks and uncertainty in
words users understand. Technical identities stay in inspectable detail.
A task may end in an answer or artifact when there is nothing to apply.
Consequential external actions need their own approval and outcome record.

An application-hosted task is another needed qualification case once a
concrete consumer exists. The application keeps its identity, domain data and
business decisions; Tesota must handle the admitted work, result and evidence
without inheriting that application's policy. A changed objective or revoked
permission must be checked before a consequential action. Qualify this through
a bounded consumer task, not a generic hosting platform built in advance.

### 3. Extensible verification and review

Make verification user-configurable. Tesota may ship native, opt-in methods,
while users and contributors can add methods for their own work. Qualify an
early native method and a user-supplied method on real tasks; extend that
contract across domains as those tasks arrive. Oxlint, LemmaScript/Dafny and
Gentle AI are candidates with existing bounded integrations or experiments;
their current contracts do not imply general availability.

A method reports a bounded claim, the result and inputs examined, its
producer and configuration, outcome and limits. Changed relevant inputs make
evidence stale. Findings, unavailable tools, incomplete runs and uncertainty
stay distinct. A reviewer assesses the result and whether evidence addresses
the user's request; it may request more work or identify an intent gap.
Neither verifier nor reviewer grants tool authority, accepts for the user or
applies a result. No single method certifies an entire task.

Implement shared contracts only where multiple real methods need them. Keep
method-specific meaning in the adapter. Make installation, configuration,
testing and removal understandable to contributors. The fabric belongs to
Tesota; external tools and community packages may live in their own repos.

### 4. Broader use and community qualification

Expand platforms, tasks, tools and methods from observed needs. Publish small
working examples and contribution contracts. Test community methods for
result integrity, effect boundaries and failures. Measure whether people
outside the project can install Tesota, finish work and understand what was
established without author guidance. Retain failed attempts and user effort.

## Rules for every increment

- Keep the user's original request and adopted completion conditions visible;
  an agent cannot quietly weaken them to make a check pass.
- Qualify the link between a check and its claim: record relevant conditions,
  test the expected outcome against an independent basis, and narrow conclusions
  when a fixture or control does not represent the intended task. See
  [claim and test validity](qualification.md#claim-and-test-validity).
- Separate permission to act, check evidence, independent review, human
  acceptance and application. Bind evidence and decisions to their result.
- State what remains unknown. Missing checks, malformed reports, timeouts and
  unconfirmed effects cannot become success.
- Give a useful default experience. Optional methods add task coverage; they
  are not universal mandatory gates.
- Qualify new process or external effects in the actual environment. There is
  no silent downgrade when required protection is unavailable.
- Keep one owner per behavior; add abstractions after implemented consumers
  reveal shared semantics.
- There are no external consumers to preserve. Remove obsolete internal
  contracts cleanly; retain legal notices and historical evidence as records,
  not runtime compatibility layers.
