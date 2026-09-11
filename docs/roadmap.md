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
2026-09-11 UTC. Historical review acceptance is not a new review or a live
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
| Candidate review and decision | Implemented for the fixed candidate tasks | Fresh diff and check, fingerprint-bound local operator decision and stale-record detection remain separate from promotion authority |
| Guarded task promotion | Live code promotion passed on Windows | Explicit source write with current acceptance, unchanged target and index checks, and a retained write journal; documentation and `pi-result-consistency` are supported |
| Real code task | Promoted with a bounded integration repair | Model repaired `piTaskPasses`; the sandbox oracle passed, the operator accepted it and exact bytes were promoted; typecheck then required one optional-index narrowing |
| Formal correction loop | Passed for bounded Windows task | `canAdmitInvocation` is used by the Pi adapters; a seeded proof failure was returned to Pi, corrected and re-verified with LemmaScript/Dafny |
| Pi Coding Agent host | Passed for bounded Windows task | Full SDK host reused Tesota's Codex credential store, allowed only `read` and `edit`, and completed the scoped Pi status task in an isolated candidate; check passed and no acceptance was recorded |
| Codex-backed Gentle reviewer relay | Passed for one retained high-risk lineage | Tesota preserved provider-issued prompts and bindings, Luna completed the remaining three immutable reviewer slots, Gentle admitted them and the exact acknowledgement burned approved authority |
| Kiln static-analysis qualification | Planned | Compare selected `dev` rules and bounded quality-gate sequencing against Tesota's pinned Oxlint profile; adopt only evidenced, low-noise rules |
| Gentle AI qualification | In progress | Contract, capabilities, parity lane, stale-binding rejection and immutable model-backed settlement passed; the combined candidate offered no correction or recovery transition, so those paths remain unqualified |
| First verified self-development cycle | Complete for the bounded cycle | One combined candidate passed Pi correction, applicable behavioral verification, immutable Gentle review, human acceptance and guarded promotion; the later integration repair is recorded separately |
| Improvements driven by use | Future direction | Add a capability only for an observed need and demonstrate its benefit |

The combined correction cycle completed through human acceptance on 2026-09-11
UTC. Pi made a bounded TypeScript change, the behavioral oracle
detected a real defect and the corrected bytes passed before the same immutable
candidate completed Gentle review. Candidate identity, evidence applicability
and provider authority remained distinct. This exercise does not establish
general editing permissions, task recovery, server-side cancellation or general
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

## First useful cycle

The intended acceptance exercise must demonstrate that:

1. A known executor changes a separate candidate within the requested scope.
2. The shared verifier detects a real failure and supports correction.
3. Changed inputs invalidate applicable evidence; absent checks do not pass.
4. Out-of-scope effects are rejected and unfinished work remains visible.
5. The report presents the diff, actual checks, observed consumption and limits.
6. Human acceptance and promotion remain separate from model completion and checks.

General terminal interaction, general candidate-checkout execution and task
recovery still need implementation. The current promotion command is limited to
the accepted documentation and `pi-result-consistency` tasks and is not a
general write capability. Do not create unused modules in anticipation of that
work.

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

The formal correction loop is complete for its bounded property. Gentle's public
review relay and one immutable four-lens settlement are also qualified. The next
increment combines those proven slices on one fresh candidate and evaluates the
provider's correction and recovery transitions. Gentle may report findings and
bounded next actions; Tesota retains acceptance and promotion authority.

Kiln's `dev` Oxlint profile and quality-gate loop are reference material for a
separate static-analysis qualification. “Anti-slop” is not an Oxlint guarantee;
candidate rules must be evaluated against real defects, false positives, tool
version identity and retained evidence before adoption. This qualification may
run before or alongside the combined correction cycle, but neither imports
Kiln's roadmap or private runtime state.

After the construction cycle is stable, define Tesota's own shell contracts and
build the shell as a Tesota-owned surface. Gentle remains behind that boundary,
so Tesota is not coupled to Gentle presentation or private state. The current
CLI and experiment commands remain the development surface until those contracts
are stable.

The eventual interaction surface is undecided. A shell or richer terminal UI
must be evaluated against the implemented workflow: giving a task, observing
progress, interrupting work, recovering a session, reviewing a diff and accepting
or rejecting changes. Select the surface before its implementation, using
hands-on comparisons, accessibility and maintenance constraints, and relevant
community experience. No particular UI framework or existing shell is adopted.

## Open requirements and scope

The original handoff included a bounded Gentle AI review integration and a small
Dafny property for the first useful cycle. The formal property is live for the
bounded invocation decision. Gentle's public relay and immutable settlement are
implemented; correction and usable recovery semantics remain unqualified. A
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
