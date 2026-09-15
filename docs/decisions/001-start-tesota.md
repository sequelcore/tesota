# 001: Start Tesota as an incremental implementation

Status: adopted project direction, reconstructed from the operator's design
conversation and bootstrap history. This record does not certify a freeze of
every Kiln branch or remote.

## Context

Kiln's original goal was to support its own development. In the operator's
experience, scope and infrastructure grew before that everyday workflow became
reliable enough to use. Continuing to add capabilities did not resolve the gap
between architectural ambition and a usable development loop.

That experience motivates this decision. It is not an audit conclusion that all
Kiln code was broken or without value. The historical source remains available
for targeted study and reuse.

## Decision

Pause further Kiln feature development as the operator's project direction and
focus new implementation work on Tesota. Start with a minimal usable package and
add bounded capabilities, each with observable behavior and proportionate checks.
Do not require feature parity with Kiln before using Tesota.

Preserve Git history and attribution. The bootstrap starts from
`4257ee9fce034cfe8e50dce3dbe3afb12f468094` on the normal `tesota/bootstrap`
branch. It replaces the application tree selectively; it does not create an
unrelated history. The [inventory](../history/bootstrap-inventory.json) records inherited
file dispositions. No Kiln implementation package was ported in the bootstrap.

Treat Kiln as a coexisting [reference implementation](../references/kiln.md).
Select code, tests and lessons for a concrete need rather than copying packages
or inheriting its roadmap. Prefer existing engine capabilities where they satisfy
the boundary; the [Pi decision](002-use-pi.md) records that choice.

The later [selective recovery decision](005-recover-kiln-selectively.md) confirms
this direction while increasing the intended reuse of Kiln's contracts, adverse
fixtures and failure knowledge. It does not authorize whole-package adoption.

## Consequences

Tesota accepts rebuilding some integration work in exchange for a smaller
foundation that can be exercised early. The cost is real: new code needs its own
verification, and selective reuse requires investigation rather than blind copying.
No comparative evidence currently establishes that this approach is cheaper in
total than extracting all relevant Kiln components.

The success criterion is a small self-development change with applicable checks
and human acceptance. Module count, passing synthetic tests or feature breadth
alone do not meet it. See the [roadmap](../roadmap.md).

The development pause is an organizational decision. This record does not claim
GitHub archival, branch protection changes, an immutable remote or enforcement
against other contributors. Tesota's bootstrap status does not authorize changes
to Kiln's coexisting checkout or operator state.
