# Repository analysis through scoped providers

Status: Accepted direction for local evaluation on 2026-10-06; adapter
implementation remains gated. Proposed on 2026-10-05.

## Context

Repository analysis has been used to mean text search, symbol navigation,
context retrieval and test selection. These operations have different claims
and are not interchangeable. Existing engines can supply useful operations,
but Tesota already owns workspace content, tool authority and check evidence.
A diagnostic TS LSP pilot did not establish benefit over the current tools.

## Decision

Keep the current tools as the baseline. When real work justifies an analysis
operation, integrate an existing engine behind that consumer's narrow
contract, with an explicit optional binding and a bounded one-shot job through
the existing execution interface. Release the engine after each query; no
engines remain in idle sessions. Add replacement providers only for concrete
supported operations; do not build a universal adapter framework or a new
engine now.

Provider answers are advisory unless their inspected content and semantic
inputs are attributable to the candidate. They cannot reduce approved checks
or turn readiness into evidence. Tesota owns admission, execution/privacy
boundaries and the operator-facing claim. See the
[design](../design/repository-analysis.md) for concepts, processes, failure,
capacity and evaluation gates.

## Consequences

The operator can eventually replace or disable a supported provider without
changing verification promises, but cannot expect every engine to implement
every capability. Tesota retains integration and lifecycle responsibility.
Criba development is paused while existing local alternatives are evaluated;
generalizing it is not active work. Reconsider it only for an observed unmet
requirement. Retirement remains a separate decision. This direction changes
no runtime or defaults and does not authorize remote analysis.

Implementation requires a real first consumer, a selected engine and explicit
resource/deadline/output budgets. Remote access requires a separate operator
decision. Advisor objections are recorded in the owning design.
