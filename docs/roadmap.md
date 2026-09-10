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
| First verified self-development cycle | Not started | Candidate edit, failure correction, applicable evidence and human acceptance |
| Improvements driven by use | Future direction | Add a capability only for an observed need and demonstrate its benefit |

The next increment is a real Tesota change in a separate candidate checkout,
with explicit file scope and checks appropriate to that change. The isolated
one-file correction exercise now passes, but it does not establish general
editing permissions, task recovery, server-side cancellation or promotion.
See the [experiment index](../experiments/README.md).

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
