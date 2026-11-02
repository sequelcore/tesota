# Reuse project trust and recorded reads

**Status:** Proposed; implementation authorized, human acceptance pending.
**Date:** 2026-11-01. **Owner:** Tesota's operator.

## Context

Checks without reports lose failure attribution. Projects outside recognized
manifests cannot declare checks. Restricted judging roles lack issue text the
parent already read. The current CLI already owns project trust, runner probes,
an append-only ledger and receipt context metadata.

## Decision

Extend those owners, as specified in the
[system design](2026-11-01-checks-context-design.md).

Normalize command, working folder and execution/report options together.
Hash-approved checkout declarations replace discovery. Each execution, including
base comparisons, rechecks the original approval. Fresh runner reports account
for unreported runtime failures before attributing a failure to the base.

Give children and request judgments structured third-party snapshots from
supported, already-returned GitHub CLI issue reads. Keep them separate from
operator requests and instructions. Record source, digest and gaps in optional
receipt-v2 context metadata. Model opinions remain independent of mechanical
standing and repair.

The operator approved CLI-only initial scope and additive receipt metadata, and
directed clean refactoring without legacy shims. No new service, verifier,
automatic retrieval authority or whole-history inheritance is introduced.

## Consequences

Changed declarations lose authority until approved again. Unknown attribution
and unavailable references remain visible gaps. Context grows within fixed caps
and can reach the selected role providers. Historical missing metadata stays
unknown; there is no reconstruction or migration layer.

Independent review led to explicit runner-error accounting, separate inherited
reference envelopes and original-checkout trust checks inside base worktrees.
The design records rejected alternatives, bounds and verification obligations.

Unresolved operator questions: none for implementation. This record does not
authorize publishing or establish acceptance of the resulting behavior.
