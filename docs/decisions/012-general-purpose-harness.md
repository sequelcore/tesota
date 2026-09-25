# 012: Build Tesota as a general-purpose verification-first harness

Status: adopted 2026-09-23. Delivery order and evidence retention superseded by
[decision 013](013-general-agent-loop-first.md).

## Context

The bounded TypeScript workflow has demonstrated scoped authority,
independent candidate work, result-bound evidence, review and guarded
application. It has not established a general harness. Intended users want to
bring varied tasks to one agent, including work outside a code repository.
Adding more fixed TypeScript profiles would miss that workflow. A standalone
verifier platform would leave the agent experience dependent on another
harness.

The [roadmap](../roadmap.md) owns sequence and status. This decision records
the product and architecture boundary, not a claim that the new capabilities
exist.

## Decision

Tesota will become an open, general-purpose agent harness with verification as
a core behavior. It should be useful with its own conversational shell and
default tools. Users can opt into native checks and reviews and add their own
methods. The community can contribute methods without requiring every method
to be built into the core package.

Task authority, result identity, evidence applicability, review and adoption
remain Tesota-owned contracts. Verifiers establish bounded claims under stated
conditions. Reviewers assess the result and the fit of evidence to the request.
Both can reveal gaps and drive correction. They do not grant authority or
replace human acceptance. Formal proof still requires checking that the proved
property expresses the user's intent.

The product surface uses plain language. Internal hashes, byte counts,
journal states and implementation terms remain available for diagnosis, but
ordinary users should see the task, actions, result, checks, limitations and
decision. The same principles must work for an answer or artifact that has no
repository patch to apply.

## Implementation boundary

Build vertical task slices with real consumers. A small shared evidence shape
may connect methods, but tool-specific result semantics and effect limits stay
with their adapters. Do not introduce a universal agent, verifier, reviewer or
plugin registry before it is needed. One repo can contain core contracts and
native adapters initially; external tools and community integrations may have
their own repositories.

No external consumers depend on current internal contracts. Refactor or remove
obsolete code and documentation without aliases, compatibility shims or
deprecated paths. Preserve LICENSE, NOTICE, historical decisions and retained
experimental evidence. This direction changes the priority of the deferred
non-code and extensibility dispositions in
[decision 011](011-evidence-gated-capabilities.md); its authority and evidence
invariants still apply.

## Consequences

The next work must make a real coding task less dependent on the fixed
TypeScript shape, then qualify a non-code task early. Each new tool or method
needs a defined user outcome, effects, result, failure states and evidence of
usefulness. Breadth will be claimed only for exercised tasks and environments.
