# Decisions

Consequential decisions, in order. Each entry says what was decided and where
its current form lives; the design documents own the current behavior and
its rationale, and a decision that later changed is marked so rather than
rewritten. The full original records are in Git at commit
[`b85d8d8f`](https://github.com/sequelcore/tesota/tree/b85d8d8f0fade5e7156f6e5293554ad754529486/docs/decisions)
(`git show b85d8d8f:docs/decisions/<file>`). Code comments cite these numbers.

A new consequential decision gets the next number here, with its date and a
short statement, and its substance goes into the design document it changes.

| # | Date | Decision | Now |
| --- | --- | --- | --- |
| 001 | 2026-09-09 | Pause Kiln and build Tesota incrementally from a minimal usable package, preserving Git history and treating Kiln as a reference, not a base to port | Current. [Overview](design/overview.md#direction), [Kiln reference](research/kiln.md) |
| 002 | 2026-09-09 | Use Pi's public APIs for agent mechanics, login and model transport; Tesota owns verification, evidence and acceptance | Current. [Overview](design/overview.md#components) |
| 003 | 2026-09-12 | Start from a natural-language message, with read-only discovery, a task proposal and an operator-approved grant before any change | Superseded by 013; the "Tesota Shell" name and the rule that a check is not acceptance remain ([sessions](design/sessions.md), [overview](design/overview.md#principles)) |
| 004 | 2026-09-13 | Qualify a fixed-command isolation boundary for the first code task | Superseded by 013 and 014 ([execution](design/execution.md)) |
| 005 | 2026-09-14 | Recover Kiln selectively: regression oracles and invariants first, code only after a matched comparison, whole packages never without a buildable boundary | Current. [Development](development.md#reusing-kiln) |
| 006 | 2026-09-14 | Present Tesota as a verification-first agent: "Work that carries its evidence" | Current, with 010's ordering. [Overview](design/overview.md#direction) |
| 007 | 2026-09-16 | Keep execution policy independent of its environment | Superseded by 014 ([execution](design/execution.md)) |
| 008 | 2026-09-16 | Rename the shared repository to `sequelcore/tesota`; the `kiln-legacy-2026-09` tag preserves Kiln's final state | Current. [Development](development.md#branches) |
| 009 | 2026-09-16 | `main` is the stable branch and `dev` the protected integration branch; work reaches them through pull requests with Ubuntu and Windows checks | Current. [Development](development.md#branches) |
| 010 | 2026-09-16 | Public documentation leads with what the person can do, then why evidence matters, then mechanism | Current. [Overview](design/overview.md#direction), [development](development.md#documentation) |
| 011 | 2026-09-18 | Admit a capability only for a core problem, with a bounded mechanism, a baseline, an observable benefit and cheap deletion | Narrowed by 013 to "a real consumer, measured when it claims an improvement". [Development](development.md#adding-a-capability) |
| 012 | 2026-09-23 | Build a general-purpose agent harness with verification as a core behavior, without speculative registries or compatibility shims | Current direction; delivery order superseded by 013. [Overview](design/overview.md#direction) |
| 013 | 2026-09-24 | Build the general coding loop first, then put verification around its result; drop per-capability qualification protocols | Current. [Overview](design/overview.md#direction) |
| 014 | 2026-09-25 | Provider-neutral execution environments; autonomy as a policy separate from isolation; Docker Sandboxes as the first isolated provider | Current. [Execution](design/execution.md) |
| 015 | 2026-09-25 | Four roles around each result (authority, verification, review, acceptance), the request record, flags, verifiers with claims, reviewers with findings, and a bounded correction loop | Current. [Assurance](design/assurance.md) |
| 016 | 2026-09-25 | Findings carry disposition, origin and standing; a refuter tests each; correction rounds validate fixes and review only their diff; depth follows facts; review is measured | Current, refined by 018. [Assurance](design/assurance.md) |
| 017 | 2026-09-25 | Host sessions in a local service that terminals attach to, reached over SSH on a tailnet | Designed, not built. [Sessions](design/sessions.md#planned-a-session-service) |
| 018 | 2026-09-25 | Check each finding's origin against the diff, making unsupported claims unknown; numbered diffs; forecast deep reviews | Current. [Assurance](design/assurance.md) |
| 019 | 2026-09-25 | Let the working agent ask read-only explorers, bounded and visible, while it stays the only writer | Built; off by default after its first evaluation. [Agents](design/agents.md#explorers) |
| 020 | 2026-09-25 | Choose a model for each role | Current. [Agents](design/agents.md#models-by-role) |
