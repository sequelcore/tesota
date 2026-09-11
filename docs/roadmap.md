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
2026-09-10 UTC. Historical review acceptance is not a new review or a live
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
| Scoped repository task | Live Windows attempt passed for the Pi decision documentation task | Saved login, bounded model operations, one scoped edit, failed then passing checks and retained review diff |
| Candidate review and decision | Implemented for the scoped documentation task | Fresh diff and check, fingerprint-bound local operator decision, stale-record detection; no promotion authority |
| Guarded paragraph promotion | Verified in temporary Windows repositories | Explicit source write with current acceptance, unchanged target and index checks, and a retained write journal |
| Real code task | Live Windows attempt passed for `pi-result-consistency` | Model repaired `piTaskPasses`; sandbox oracle failed first, passed after correction; source remained unchanged |
| Formal correction loop | Passed for bounded Windows task | `canAdmitInvocation` is used by the Pi adapters; a seeded proof failure was returned to Pi, corrected and re-verified with LemmaScript/Dafny |
| Kiln static-analysis qualification | Planned | Compare selected `dev` rules and bounded quality-gate sequencing against Tesota's pinned Oxlint profile; adopt only evidenced, low-noise rules |
| Gentle AI qualification | In progress | Package contract, capabilities and isolated bootstrap passed; high-risk lens selection reached a bounded timeout before mutation; model-backed review, correction and recovery remain |
| First verified self-development cycle | In progress | Bounded documentation task demonstrated; human acceptance, promotion and broader code-task verification remain open |
| Improvements driven by use | Future direction | Add a capability only for an observed need and demonstrate its benefit |

The next increment extends the bounded cycle to formal correction of one real
TypeScript property, with human acceptance kept separate from model completion.
The code-task attempt used a sandboxed behavioral oracle and failure correction;
guarded paragraph promotion is implemented
as an explicit command that preserves conflicting source work by refusing the write.
Review and local operator decision recording are implemented, with recovered
decisions treated as untrusted assertions rather than promotion authority. The
[scoped documentation task](tasks.md) now runs through a bounded live model attempt.
It does not establish general editing permissions, task recovery, server-side
cancellation or general promotion.
See the [experiment index](../experiments/README.md).
See [candidate checkouts](candidates.md) for the new preparation commands.

## Formal correction loop

The target experience is a bounded construction loop:

```text
task and property -> Pi implements -> LemmaScript/Dafny checks ->
diagnostic feedback -> Pi corrects -> the property is checked again
```

The first Tesota slice will use one pure TypeScript function with a small,
explicit property. A deliberately defective implementation must fail the formal
check, the agent must repair the implementation or propose a contract change,
and the second check must bind to the corrected candidate. A contract change
that weakens or contradicts the intended requirement requires human review; the
agent may not silently make the obligation easier to prove.

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

Terminal interaction, general candidate-checkout execution and task recovery
still need implementation. The current promotion command is limited to the
accepted documentation task and is not a general write capability. Do not create
unused modules in anticipation of that work.

## Interface and review sequencing

The formal correction loop is complete for its bounded property. The next
increment is Gentle AI qualification, not a dependency adoption: establish the
exact Gentle review contract, run a bounded provider experiment, and compare
its candidate identity, review evidence, recovery and correction behavior with
Tesota's existing cycle. Gentle review may report findings and bounded next
actions; Tesota retains acceptance and promotion authority.

Kiln's `dev` Oxlint profile and quality-gate loop are reference material for a
separate static-analysis qualification. “Anti-slop” is not an Oxlint guarantee;
candidate rules must be evaluated against real defects, false positives, tool
version identity and retained evidence before adoption. This qualification may
run before or alongside Gentle qualification, but neither imports Kiln's
roadmap or private runtime state.

After qualification, define Tesota's own shell contracts and build the shell as
a Tesota-owned surface. A future Gentle integration belongs behind that
boundary, so Tesota is not coupled to Gentle commands, presentation or private
state. The current CLI and experiment commands remain the development surface
until those contracts are stable.

The eventual interaction surface is undecided. A shell or richer terminal UI
must be evaluated against the implemented workflow: giving a task, observing
progress, interrupting work, recovering a session, reviewing a diff and accepting
or rejecting changes. Select the surface before its implementation, using
hands-on comparisons, accessibility and maintenance constraints, and relevant
community experience. No particular UI framework or existing shell is adopted.

## Open requirements and scope

The original handoff included a bounded Gentle AI review integration and a small
Dafny property for the first useful cycle. The formal property is now live for
the bounded invocation decision. Gentle integration remains proposed pending
qualification of its public contract, recovery semantics and evidence model.
A formal model or provider review would not by itself prove the implementation
correct or grant promotion authority.

Pi is the selected candidate engine, with replacement contained by the integration
boundary. Codex OAuth is the initial inference route. The fixed Spark selection
belongs to the current experiment; it does not establish a permanent product
model or subscription requirement. Account/model availability remains a live
prerequisite, separate from successful authentication.

Keep initial work to one active writer and a small set of necessary capabilities.
GUI applications, a marketplace, automatic account rotation, multiple providers,
autonomous teams and the full Kiln roadmap are outside the initial direction.
Repository Analysis is a possible later capability, conditional on actual use.
Public branding, distribution and release readiness remain undecided.
