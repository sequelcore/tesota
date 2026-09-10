# Direction and status

The first useful Tesota should take a bounded task on a candidate checkout,
make a small change, run verification, correct detected failures and present the
diff and evidence for human acceptance. A known usable version should remain
available while its successor is developed.

This is the product direction reconstructed from the operator's design
conversation and subsequent local reports. It is maintained here as project
context. The conversation itself is a private historical source, not an executable
specification. [Architecture](architecture.md) describes what is implemented.

## Milestones

Status below reflects the repository at implementation commit `1ae392f8` and
retained reports. Historical review acceptance is not a new review or a live
validation of the current checkout.

| Increment | Status | Outcome or remaining condition |
| --- | --- | --- |
| Local inspection | Reported complete | Historical source and reconstruction scope established |
| Minimal package | Complete for scaffold scope | CLI, build, types, tests and lint; [recorded evidence](history/scaffold-validation.md) |
| Shared verification | Reported independently accepted for bounded Oxlint scope | Single-file execution, binding, applicability and durable recovery |
| Synthetic Pi compatibility | Reported independently accepted | [Synthetic behavior and limitations](../experiments/pi/README.md) |
| Live login and turn probes | Open | Device-code login succeeded; the retained full probe failed before cancellation probing |
| Live verification tool | Not started | Real model requests the existing bounded verifier through Tesota admission |
| First verified self-development cycle | Not started | Candidate edit, failure correction, applicable evidence and human acceptance |
| Improvements driven by use | Future direction | Add a capability only for an observed need and demonstrate its benefit |

The next missing live evidence is a successful normal turn and an observed abort
through the bounded live path. The failed run proves neither model availability
nor a specific historical cause. Diagnostic support was added afterward; no
successful second full-probe result is retained here. See the [experiment index](../experiments/README.md).

## First useful cycle

The intended acceptance exercise must demonstrate that:

1. A known executor changes a separate candidate within the requested scope.
2. The shared verifier detects a real failure and supports correction.
3. Changed inputs invalidate applicable evidence; absent checks do not pass.
4. Out-of-scope effects are rejected and unfinished work remains visible.
5. The report presents the diff, actual checks, observed consumption and limits.
6. Human acceptance and promotion remain separate from model completion and checks.

Terminal interaction, candidate execution, task recovery and promotion still need
implementation. Do not create unused modules in anticipation of that work.

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
