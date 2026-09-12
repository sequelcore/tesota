# Direction and status

The [product identity](identity.md) defines Tesota's purpose and intended experience.
The first useful Tesota should take a bounded task on a candidate checkout,
make a small change, run verification, correct detected failures and present the
diff and evidence for human acceptance. A known usable version should remain
available while its successor is developed.

This is the product direction reconstructed from the operator's design
conversation and subsequent local reports. It is maintained here as project
context. The conversation itself is a private historical source, not an executable
specification. [Architecture](architecture.md) describes what is implemented.

## Milestones

Status below combines implementation records and retained live evidence through
2026-09-12 UTC. Historical review acceptance is not a new review or a live
validation of the current checkout.

| Increment | Status | Outcome or remaining condition |
| --- | --- | --- |
| Local inspection | Reported complete | Historical source and reconstruction scope established |
| Minimal package | Complete for scaffold scope | CLI, build, types, tests and lint; [recorded evidence](history/scaffold-validation.md) |
| Shared verification | Reported independently accepted for bounded Oxlint scope | Single-file execution, binding, applicability and durable recovery |
| Synthetic Pi compatibility | Reported independently accepted | [Synthetic behavior and limitations](../experiments/pi/README.md) |
| Live login and turn probes | Passed for bounded Windows probe | Saved login, exact answer with Pi thinking, and observed abort; two invocations, no tools or exceeded limits |
| Reusable authentication | Live reuse verified; live refresh unverified | Saved credentials resolved without another login; refresh and logout have synthetic coverage |
| Live verification tool | Passed for fixed Windows fixture | Real model requested the admitted check, received the bounded result in continuation, and completed; issued evidence saved locally |
| Candidate correction exercise | Passed for isolated one-file scope | Live model corrected the seeded defect, both checks were saved, earlier evidence became stale and final evidence remained applicable; review diff retained |
| Independent candidate checkout | Locally verified on Windows | Create a detached committed copy with independent Git storage; inspect baseline changes while preserving source state |
| Candidate lifecycle and cleanup | Implemented for bounded local storage | List and inspect candidates by ID, explicitly abandon obsolete work, and remove only old rejected, abandoned or failed checkout contents while retaining evidence |
| Scoped repository task | Live Windows attempt passed for the Pi decision documentation task | Saved login, bounded model operations, one scoped edit, failed then passing checks and retained review diff |
| Registered task execution | Passed for a second live task | One immutable registry owns four task contracts and the shared engine has no task-name branches; the candidate-source task passed direct, simulated-Pi and stored-OAuth live correction through the same bounded operations |
| Registered multi-file task | Locally verified for a two-file write set | One task can read, replace, check, review and promote two registered paths; checks and review bind the ordered write set, and promotion preflights every source target before its first rename |
| Natural-language task proposal | Stored-OAuth discovery and dirty-input blocking passed | A Spanish goal named no files; bounded read-only discovery selected one documentation path, retained a strict proposal and reported relevant excluded changes with no candidate or execution authority |
| Native terminal shell | Live answer and local result contract verified | Interactive `tesota` accepts one natural-language message and returns a grounded answer, necessary clarification or non-authoritative task proposal; continuation, approval, execution, progress and review remain unimplemented |
| Task recovery successor | Passed for one interrupted live task | An explicit command validated the failed predecessor, recreated its exact baseline in a clean candidate, recorded the relationship and completed a fresh Pi correction without inheriting bytes, evidence or acceptance |
| Candidate review and decision | Implemented for the fixed candidate tasks | Fresh diff and check, fingerprint-bound local operator decision and stale-record detection remain separate from promotion authority |
| Guarded task promotion | Live code promotion passed on Windows | Explicit source write with current acceptance, unchanged target and index checks, and a retained write journal; documentation and `pi-result-consistency` are supported |
| Real code task | Promoted with a bounded integration repair | Model repaired `piTaskPasses`; the sandbox oracle passed, the operator accepted it and exact bytes were promoted; typecheck then required one optional-index narrowing |
| Formal correction loop | Passed for bounded Windows task | `canAdmitInvocation` is used by the Pi adapters; a seeded proof failure was returned to Pi, corrected and re-verified with LemmaScript/Dafny |
| Pi Coding Agent host | Passed for bounded Windows task | Full SDK host reused Tesota's Codex credential store, allowed only `read` and `edit`, and completed the scoped Pi status task in an isolated candidate; check passed and no acceptance was recorded |
| Codex-backed Gentle reviewer relay | Passed for one retained high-risk lineage | Tesota preserved provider-issued prompts and bindings, Luna completed the remaining three immutable reviewer slots, Gentle admitted them and the exact acknowledgement burned approved authority |
| Static-analysis qualification | Complete for seven selected additions | Five Kiln `dev` rules entered v2; two native, low-evidence rules inspired by `anti-slop` entered v3; noisy structural limits and external plugins were rejected |
| Cyclomatic-complexity gate | Adopted for the complete TypeScript corpus | All 11 measured hotspots were refactored with focused behavior checks; `bun run lint` now enforces classic cyclomatic complexity at maximum 20 across `src` and `tests`, without baselines or exceptions |
| Gentle AI qualification | Correction and scope-change recovery paths passed | Immutable settlement, interrupted capture re-entry, provider-authorized correction and one native `scope_changed` successor passed; other recovery dispositions remain unqualified |
| First verified self-development cycle | Complete for the bounded cycle | One combined candidate passed Pi correction, applicable behavioral verification, immutable Gentle review, human acceptance and guarded promotion; the later integration repair is recorded separately |
| Improvements driven by use | Future direction | Add a capability only for an observed need and demonstrate its benefit |

The combined correction cycle completed through human acceptance on 2026-09-11
UTC. Pi made a bounded TypeScript change, the behavioral oracle
detected a real defect and the corrected bytes passed before the same immutable
candidate completed Gentle review. Candidate identity, evidence applicability
and provider authority remained distinct. This exercise does not establish
general editing permissions, same-session resume, server-side cancellation or general
promotion. The operator accepted the current review fingerprint and the guarded
command later promoted those exact bytes.
See the [experiment index](../experiments/README.md).
See [candidate checkouts](candidates.md) for the new preparation commands.

## Formal correction loop

The target experience is a bounded construction loop:

```text
task and property -> Pi implements -> LemmaScript/Dafny checks ->
diagnostic feedback -> Pi corrects -> the property is checked again
```

The first Tesota slice used one pure TypeScript function with a small, explicit
property. Its deliberately defective implementation failed the formal check,
Pi repaired the implementation, and the second check bound to the corrected
candidate. The same rule governs future cycles: a contract change that weakens
or contradicts the intended requirement requires human review; the agent may
not silently make the obligation easier to prove.

The result is verification evidence, not acceptance authority. Tesota must bind
each observation to the exact candidate bytes and observed tool versions, keep
integration tests for behavior outside the formal boundary, and report what the
property does not cover. A passing proof does not establish requirements that
were never expressed in the contract.

Kiln's `dev` branch is the reference implementation for this direction: it
already contains `formal_verify`, a bounded verification loop, Gentle AI review,
and a diagnostic LemmaScript-to-Dafny qualification. Tesota may reuse the
lessons and contract boundaries, but it owns its reduced implementation and
evidence; it does not inherit Kiln's private state, roadmap or acceptance
decisions.

Checkout validation passed 183 tests, build, typecheck and lint on Windows. A real
candidate was created from `662c3726775baffe27afcd0f82758ac41c3a70f6` and inspected
with no candidate changes. Source status, refs, index and HEAD remained unchanged;
uncommitted source work was excluded. No candidate task or candidate build ran
during checkout validation.

Task-scope validation passed 194 tests, build, typecheck and lint on Windows.
The real candidate was prepared for `pi-decision-status`; its initial documentation
check failed as expected because the stale paragraph remained unchanged.
Candidate inspection still reported no changes, and source status was unchanged.
No live model attempt or candidate edit ran during this validation.

The subsequent live-task increment passed 202 tests, build, typecheck and lint.
On 2026-09-10 UTC, one live attempt against baseline
`0a4308055f55218882fdd972eb321f2c52a65f24` completed with five model invocations,
six tool calls, one edit and two checks. The initial check failed, the final check
passed, and both results were supplied to the model. A later read-only check
matched the final source hash; inspection found only the permitted decision-file
change. Source status, refs and index remained unchanged. The private candidate
retains its diff and attempt record, including executor hashes for the uncommitted
implementation used. Human acceptance was not evaluated and nothing was promoted.

Review and decision validation passed 206 tests, build, typecheck and lint on
Windows. Temporary candidates exercised acceptance, rejection, stale fingerprints,
forged saved claims and malformed decisions. The retained live candidate was
reviewed through the compiled CLI: its current check passed and its decision
remained absent. No live inference or real-candidate decision was needed for this
increment.

Guarded promotion validation passed 214 tests, build, typecheck and lint. The
compiled CLI applied an accepted paragraph in a temporary source repository while
preserving its index, HEAD and unrelated edits. Negative cases rejected newer
working bytes, staged or committed target changes, changed candidates, a wrong
source directory, missing acceptance and an existing journal. The final permission
preservation change also passed a focused CLI rerun. No real candidate was accepted
or promoted, and no live model was invoked for this increment. Recovery after a
process crash or power loss remains unverified.

The code-task attempt completed on 2026-09-10 UTC against baseline
`3752e2b0465560fea45a8b2ae99bb1c98bf7e7ba`. It used five model invocations,
four tool calls, one edit and two issued checks. The first sandbox check reported
14 rejected evidence cases; the corrected predicate passed all cases and the
current read-only check matched its hash. No source edit, commit or promotion
occurred. Several earlier attempts failed safely on malformed tool input or
incomplete corrections and retained their evidence.

The first formal property is now implemented in
`src/verification/invocation-admission.ts`. LemmaScript 0.6.1 generated the
Dafny artifact and Dafny 4.11.0 verified one contract with zero errors. The
property is used before model admission in the task, live-probe and verification
adapters. This proves only the bounded admission predicate and does not grant
acceptance authority.

The live formal correction task completed on 2026-09-11 UTC against baseline
`20833acc7927e7c08df6b42fd5baa5e63ecf0422`. It used five model invocations,
four tool calls, one edit and two issued checks. The seeded implementation
failed with a Dafny postcondition diagnostic; Pi received that result, corrected
the implementation and supplied the passing check. The current candidate check
also passed. The candidate remains isolated and unaccepted; formal evidence does
not grant promotion authority.

The first task-recovery successor was exercised live on 2026-09-11 UTC. Candidate
`b7ce6564-6c22-4c1d-9135-d18c5dfbb8fb` was explicitly interrupted after three
model invocations, two tool calls, no edit and one issued failed check. Tesota
retained its settled `aborted` session and failed outcome. The recovery command
created successor `609f2fdf-4fea-4711-9775-d11b5587922e` from the same
`ae6c7d81a10231d0d9775b6325fe079111c12046` baseline and recorded that relation.
The successor used five model invocations, four tool calls and one edit; its
failed then passing checks shared the same verifier identity, and the current
read-only check matched the corrected bytes. The pre-existing candidate remained
unchanged. The final diff was empty because this task restores baseline bytes;
neither candidate received an operator decision or promotion authority.

## First useful cycle

The intended acceptance exercise must demonstrate that:

1. A known executor changes a separate candidate within the requested scope.
2. The shared verifier detects a real failure and supports correction.
3. Changed inputs invalidate applicable evidence; absent checks do not pass.
4. Out-of-scope effects are rejected and unfinished work remains visible.
5. The report presents the diff, actual checks, observed consumption and limits.
6. Human acceptance and promotion remain separate from model completion and checks.

The primary inline terminal session has started, while operator-defined task
execution still needs implementation. The proposed [natural-language task experience](decisions/003-natural-language-task-experience.md)
lets an operator state an outcome without naming files, then separates read-only
discovery, a task proposal, an operator-approved run grant, bounded candidate
execution and later review and promotion. Registered single-file and multi-file
tasks now share one execution path, but operators cannot yet use that flow or
supply executable task manifests. The current promotion
command remains limited by the selected definition's explicit policy and is not
a general write capability. Recovery restarts from the same baseline in a clean
successor; same-candidate/session continuation and promotion-journal recovery
remain unsupported. Do not create unused modules in anticipation of that work.

## Combined correction cycle

The handoff required one fresh, repository-owned task whose requirement and
verification oracle were explicit before inference began:

1. Pi changes only the admitted files in an isolated candidate checkout.
2. Oxlint, a behavioral check or LemmaScript/Dafny exposes a real seeded defect.
3. Pi receives the exact diagnostic and corrects the implementation without
   weakening the requirement or formal contract.
4. Verification is rerun and bound to the corrected candidate bytes.
5. Gentle reviews that same immutable candidate through its public relay. Any
   actionable finding is either corrected through a new provider-authorized
   transition or recorded as unresolved; authority is never reconstructed.
6. Tesota presents the final diff, applicable evidence and remaining limits for
   a separate human decision; any promotion remains an explicit later command.

The cycle used `pi-result-consistency` on candidate
`9783bee4-f5e7-4de5-8705-5253c2d77ffc`, based on
`168944ddb3469f50f3c69a520701403be8af28b2`. The first issued behavior check
reported 14 rejected evidence cases. Pi received it, changed only
`src/integrations/pi-task.ts`, and the second issued check passed with source
SHA-256 `ec9af28b47470956d33faa5726642e580eec65cd051d118f3a2dcea722e6bca3`.
The read-only current check matched those bytes. Two earlier fresh attempts
failed safely when candidate bodies used TypeScript-only syntax; the checker was
then corrected to return that exact diagnostic without changing its behavioral
obligations.

Gentle reviewed the same frozen candidate through the public relay under lineage
`review-6a859e0e80e5d67c` and target
`sha256:fc55b0069e48c2f6c30fdd7b9fe5325c8e8ebaab88b84a0e0f2ed3444dc8c4f3`.
Its reliability review approved the candidate with one informational warning and
explicitly opened no correction. Bound status allowed only acknowledgement and
forbade recovery, repair and validation because the native status had not
selected them. The exact acknowledgement burned the provider authority. Thus
this real cycle offered no usable correction or recovery transition; those
paths remain unqualified rather than being reconstructed by Tesota.

A later high-risk candidate `fd1dff8e-476f-4fe6-a5fa-7f3a47e8b697`
deliberately weakened the absolute-path admission check in
`src/integrations/gentle-process.ts` from disjunction to conjunction. The
predeclared behavior probe failed because one relative executable with an
absolute working directory reached process execution instead of the admission
error. Gentle froze that one-file, two-line candidate under lineage
`review-49a5c41db9a2f57b` and selected four lenses. Two explicit Tesota relay
attempts failed before artifact production; a separate bounded Codex probe
confirmed successful stored OAuth authentication followed by HTTP 429 at model
request admission before inference. Gentle retained `reviewing` authority and
reoffered the same identity-bound `review-risk` slot. No artifact was submitted,
no candidate byte was corrected and no `review.recover` transition was offered.
This qualified safe capture re-entry after an interrupted reviewer transport,
not correction or native authority recovery; the live correction exercise was
blocked until the authorized model became available.

After model availability returned, the interrupted high-risk lineage admitted
all four lenses. Gentle recorded a deterministic introduced `CRITICAL`, but a
second lens supplied conflicting causal evidence, so the provider closed the
lineage as terminal `escalated` and allowed only `stop`. No correction or
recovery was reconstructed from that result.

A narrower `pi-result-consistency` candidate
`863e280c-6512-45ca-989e-12c90955d2aa`, based on
`eda9f4d7400ab42265b97272359bd9626fdd1aef`, changed the final current-check
conjunction into a precedence-bypassing disjunction. Its pre-existing 26-case
oracle rejected 23 cases before review. Gentle froze the candidate under
lineage `review-6522051d6b1f0d20`; its single reliability lens admitted
`R3-precedence-bypass` as an introduced deterministic `CRITICAL` and opened
`correction_required`. The provider accepted a two-line correction plan, then
bound the corrected tree after the conjunction was restored with explicit
grouping. The same oracle passed on source SHA-256
`573af3f2aaa78d499b2fe58a13688f1c34e15aa13ab24b8e558fd74db1b66f65`.
Gentle's targeted validator ran through Tesota's fixed tool-free Pi process relay,
closed the review as `approved` and emitted an exact acknowledgement; executing
it burned the review authority. No human decision or promotion was recorded.
This qualifies the native correction path. The later recovery qualification
records a real `review.recover` successor after changed scope.

Tesota's separate review fingerprint is
`fc4031e766ce9002da5e05e18dbfc524776e4052e6521d1c2a1f567a727e7ceb`.
The operator recorded `accept` for that fingerprint, and Tesota reported the
decision as current. The guarded command later promoted those exact candidate
bytes and retained its write journal. Repository typecheck then exposed an
unchecked-index typing defect outside the behavioral oracle; the source received
the behavior-preserving `checks[1]?.status` narrowing. That roll-forward does not
inherit the candidate acceptance. The full live observations and limits are
recorded in the [Gentle qualification](../experiments/gentle/README.md).

## Interface and review sequencing

The formal correction loop, combined correction cycle, provider-authorized
correction and one native `scope_changed` recovery are qualified for their
bounded cases. Gentle may report findings and bounded next actions; Tesota
retains acceptance and promotion authority. Recovery dispositions for
invalidation or escalation remain separate qualifications.

The static-analysis qualification resolved local Kiln `dev` to
`9b604b105fbf3644328e187b862233660280b604` and evaluated its 105-rule set with
the pinned Oxlint 1.82.0. A 53-file Tesota scan produced 159 diagnostics, all
from six structural limits, so those limits were not adopted. Five file-local
rules detected their deliberate defect fixtures, passed corresponding controls
and produced no findings on the current repository; they now extend the fixed
profile as `oxlint-static/v2`. Tesota's existing check sequencing remains the
owner because no separate quality-gate runtime consumer was demonstrated.
“Anti-slop” remains outside the Oxlint contract. See the
[retained evaluation](../experiments/oxlint/README.md).

A follow-up used `dmmulroy/anti-slop` at
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` as policy inspiration without
vendoring its plugin. Tesota removed avoidable production assertions and added
the native `typescript/no-non-null-assertion` and
`oxc/no-accumulating-spread` rules. Six existing non-null assertions in tests
were replaced by explicit guards; the final two-rule scan produced no findings
across the same 53 files. Defect and control fixtures bind both additions to
`oxlint-static/v3`.

The interaction contract is now proposed in
[decision 003](decisions/003-natural-language-task-experience.md) from hands-on
comparison of installed tools, local reference harnesses, vendor documentation
and community reports. The first surface should be an inline terminal workflow;
a full-screen TUI or GUI is not required to validate the contract. Gentle remains
behind the Tesota-owned boundary, so provider presentation and private state do
not define Tesota's request, grant, progress, review or promotion semantics.

Read-only conversational discovery is now implemented for Tesota's own repository.
The shell can return a grounded answer, one necessary clarification or a task
proposal through one strict result union. Only proposals are retained; every result
has zero execution authority. The explicit `task propose` command remains a narrower
proposal-only consumer. This behavior has local fake-provider coverage, and one
stored-OAuth question produced a grounded answer without retaining a proposal;
clarification remains unqualified in live use. A proposal accepts a
natural-language outcome without requiring file names, binds a committed
baseline, exposes only bounded list, literal-search, baseline-read and submission
tools, reports relevant dirty-path conflicts and retains a non-authoritative
proposal. Mutation, repository-code execution and model-controlled network access
fail closed during discovery; configured inference transport is reported
separately. Local fake-provider behavior and stored-OAuth `blocked_dirty` and
clean `ready` proposals are qualified. Neither live result establishes proposal
correctness, acceptance or executable admission.

The next product increment extends the thin inline `tesota` session with a narrow
`task start <proposal-id>` consumer. It must let an operator complete one real
task through request, proposal, one approval, isolated execution, applicable
checks, diff, human decision and conflict-safe promotion without manually copying
lifecycle identifiers. It adds a trusted proposal-admission owner rather than
weakening the current five-task registry, binds applicable oracles to immutable
obligation inputs and sandboxes any candidate command that runs. The first slice
rejects replay, concurrent or resumed execution and unsupported scope instead of
implementing general successors. Scope expansion, richer recovery, arbitrary
shell execution, mandatory external review and a full-screen TUI remain later
slices justified by observed use.

## Open requirements and scope

The original handoff included a bounded Gentle AI review integration and a small
Dafny property for the first useful cycle. The formal property is live for the
bounded invocation decision. Gentle's public relay, immutable settlement,
provider-authorized correction and one scope-change successor are implemented
and qualified. Recovery after invalidation or escalation remains unqualified. A
formal model or provider review does not by itself prove the whole implementation
correct or grant promotion authority.

Pi is the selected candidate engine, with replacement contained by the integration
boundary. Codex OAuth is the initial inference route. The fixed Luna selection
belongs to the current experiments; it does not establish a permanent product
model or subscription requirement. Account/model availability remains a live
prerequisite, separate from successful authentication.

Keep initial work to one active writer and a small set of necessary capabilities.
GUI applications, a marketplace, automatic account rotation, multiple providers,
autonomous teams and the full Kiln roadmap are outside the initial direction.
Repository Analysis is a possible later capability, conditional on actual use.
Public branding, distribution and release readiness remain undecided.
