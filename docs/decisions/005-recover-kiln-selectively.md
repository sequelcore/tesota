# 005: Recover Kiln selectively through contracts and regression oracles

Status: adopted extraction policy. Individual code adoption still requires a
separate, evidence-backed implementation decision.

## Context

Tesota began as a clean reconstruction because Kiln's product and package scope
had grown beyond the ordinary development loop Tesota needed to prove first.
That decision reduced inherited coupling, but it did not make Kiln's engineering
knowledge obsolete.

A read-only audit of Kiln `dev` at
`9b604b105fbf3644328e187b862233660280b604` classified 42 candidate decision
units. The audit inspected selected source, tests, architecture and historical
qualification records. It did not execute Kiln, rerun its evaluations or inspect
Tesota. The frozen Kiln snapshot is therefore a reference source, not a
qualified dependency or functional baseline.

The audit also found meaningful counterevidence to a simplistic rewrite story:
Kiln had a historically qualified Windows source baseline, real consumers for
parts of its bounded-work lifecycle and a substantial failure-oriented test
corpus. Reconstructing those lessons from nothing would waste useful work.

## Decision

Continue Tesota as a clean, independently owned implementation while recovering
Kiln more aggressively in the following order:

1. behavioral oracles and adverse fixtures;
2. stable invariants and domain contracts adapted to Tesota's vocabulary;
3. small algorithmic fragments only when a matched implementation experiment
   shows lower total cost than a Tesota-native implementation;
4. whole modules or packages only after proving an independently buildable
   boundary with a current Tesota consumer.

No Kiln package is approved for unchanged adoption by this decision. Kiln's
roadmap, private state, control plane, model gateway, account pools, GUI and
cross-harness projection architecture remain outside Tesota's inherited scope.

The first implementation comparison will target one ordinary repository-check
and correction capability. A Tesota-native spike and a thin Kiln-derived spike
must use the same task corpus, authority, verifier definitions, model route,
budgets and failure oracles. Literal reuse wins only if it reduces engineering
and operator cost without weakening candidate identity, authority, evidence or
recovery behavior.

## Required preservation

The following semantics are long-term Tesota requirements regardless of their
implementation source:

- approved authority revisions are immutable;
- accounting follows the task lineage across retries and recovery;
- candidate identity refers to actual content and relevant check inputs;
- evidence identifies its subject, producer and execution conditions;
- observations, assurance, human acceptance and promotion remain separate;
- unknown settlement is represented explicitly and cannot authorize replay;
- recovery does not silently inherit authority;
- future child authority cannot exceed its parent grant;
- hard limits and review-triggering tripwires remain distinct;
- configuration has one canonical owner and project configuration can narrow,
  but not invent, authority.

Candidate content, verification attempt and recovery lineage are separate
dimensions. A settled verifier retry against identical bytes must not require a
fabricated source mutation.

## Consequences

The next product proof remains ordinary useful work: admitted repository checks,
task-sized multi-file changes, bounded diagnostic correction and a recoverable
closeout that does not require the operator to coordinate internal identifiers.
Governance breadth is not a substitute for that workflow.

Every recovered behavior receives a Tesota-side qualification test. Source
inspection and an old passing Kiln test are not qualification of the adapted
implementation. Reused code must record its exact source commit and path,
adaptations, attribution and license obligations.

The detailed classification and evidence limits are maintained in the
[Kiln extraction reference](../references/kiln-extraction.md). The original
[reconstruction decision](001-start-tesota.md) remains valid and is narrowed by
this policy: clean reconstruction means selective ownership, not loss of
institutional knowledge.
