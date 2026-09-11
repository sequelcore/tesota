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
| First verified self-development cycle | In progress | Bounded documentation task demonstrated; human acceptance, promotion and broader code-task verification remain open |
| Improvements driven by use | Future direction | Add a capability only for an observed need and demonstrate its benefit |

The next increment extends the bounded cycle to review and guarded promotion of a
real code task, with human acceptance kept separate from model completion.
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

## First useful cycle

The intended acceptance exercise must demonstrate that:

1. A known executor changes a separate candidate within the requested scope.
2. The shared verifier detects a real failure and supports correction.
3. Changed inputs invalidate applicable evidence; absent checks do not pass.
4. Out-of-scope effects are rejected and unfinished work remains visible.
5. The report presents the diff, actual checks, observed consumption and limits.
6. Human acceptance and promotion remain separate from model completion and checks.

Terminal interaction, general candidate-checkout execution, task recovery and promotion still need
implementation. Do not create unused modules in anticipation of that work.

## Interface sequencing

Complete the real development-cycle work and integrate the required Gentle AI
review and Dafny property before implementing terminal interaction. The current
CLI and experiment commands remain the development surface during that work.

The eventual interaction surface is undecided. A shell or richer terminal UI
must be evaluated against the implemented workflow: giving a task, observing
progress, interrupting work, recovering a session, reviewing a diff and accepting
or rejecting changes. Select the surface before its implementation, using
hands-on comparisons, accessibility and maintenance constraints, and relevant
community experience. No particular UI framework or existing shell is adopted.

## Open requirements and scope

The original handoff included a bounded Gentle AI review integration and a small
Dafny property for the first useful cycle. Neither exists here. Their exact
contracts, feasible integration and connection to TypeScript behavior remain
unresolved; they have not been silently removed from the direction. A formal
model would not by itself prove the implementation correct.

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
