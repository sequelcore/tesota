# Identity and purpose

**Tesota is an open-source, verification-first agent.**

Describe what you need and work with Tesota toward a result you can inspect,
correct and choose to use.

> **Work that carries its evidence.**

The intended experience is a normal agent conversation. Tesota should keep the
scope, checks, authority and work history understandable without requiring the
user to operate an internal lifecycle. Software development is the first
proving ground for that experience, not the permanent limit of the product.

## Product scope

Tesota's destination, next proof and current implementation are deliberately
different:

| Horizon | Meaning |
| --- | --- |
| **Implemented today** | A local, terminal-first pre-release that can answer bounded repository questions and attempt one narrow class of TypeScript source changes with explicit approval, checks, review and application. |
| **Next demonstrated capability** | Complete one small repository change in one continuous conversation, including useful correction and a return to a useful prompt. |
| **Long-term thesis** | An agent for research, planning, creation, tool use and other consequential work, where each domain defines its result, applicable evidence, effects and adoption boundary. |

Tesota does not yet support arbitrary repository work, general web research,
unrestricted commands, issue publication or general-purpose non-code
workflows. The [roadmap](roadmap.md) is the sole owner of current product status
and priority. The [architecture](architecture.md) describes the implementation
that exists.

## The experience

The user-facing mental model is:

```text
Ask -> Work <-> Check <-> Correct -> Review -> Apply
```

This is a flexible conversation, not six mandatory ceremonies. A read-only
question can end with an answer. A check can happen before, during or after an
edit. Correction can follow a diagnostic or human feedback. Applying a result
is a separate consequential action, and earlier effects may also require their
own authority.

The current implementation still exposes some seams in this experience. A
supported change can move from a natural-language request through approval,
work, checks, review and application without the user copying internal IDs, but
semantic revision and conversational continuation after the task are not yet
implemented. [Using Tesota](using-tesota.md) documents the exact supported
workflow without presenting the destination as current behavior.

## Why verification-first

AI makes production abundant. Evidence remains scarce. A persuasive answer, a
polished change or a successful tool transcript does not by itself establish
that the result is correct, current or authorized to take effect.

Verification-first means that Tesota keeps four commitments visible:

1. **Checks state what they establish.** A typecheck, test, review and policy
   check answer different questions.
2. **Evidence stays attached to an exact result.** If the result changes, old
   evidence remains history and the affected claims need checking again.
3. **Unknowns remain explicit.** Passing one check does not become a universal
   declaration that the work is “verified.”
4. **Evidence informs a decision; it does not grant authority.** Producing,
   checking, accepting and applying a result are distinct facts.

A useful summary should therefore look like this:

```text
Changed:
- src/auth.ts
- src/session.ts

Checked:
PASS Scope integrity: only admitted files changed
PASS TypeScript no-emit: this exact result passed typescript-no-emit/v1

Not established:
- requested behavior and completion conditions
- full integration suite

Changed since checking: No
Application: Not applied; awaiting your decision
```

The current shell renders this structure for its supported TypeScript task. The
specific checks and unknowns must change when a later task has a different
evidence contract.

## Enduring principles

The simpler product story does not weaken the lifecycle beneath it:

1. **Production is not proof.** Model completion does not establish task
   completion.
2. **Verification is part of execution.** Checks can guide work before the final
   result, not merely reject it afterward.
3. **Diagnostics are useful inputs.** A bounded failure can lead to correction
   and renewed verification.
4. **Evidence has a subject.** An observation identifies the exact result and
   relevant conditions it describes.
5. **Changed results need renewed evidence.** Old evidence remains historical;
   it does not silently apply to new work.
6. **Different claims need different verifiers.** No single check establishes
   every property of a task.
7. **Evidence does not create authority.** A passing tool, reviewer or model
   cannot silently approve or apply its own result.
8. **Failure states remain honest.** A finding, unavailable tool, timeout,
   cancellation and uncertain effect are not interchangeable.
9. **Verification is proportional.** Required evidence depends on the work, its
   effects and the cost of being wrong.
10. **Telemetry describes; it does not authorize.** Visibility can improve a
    decision without becoming a permission source.
11. **Authority and confinement are different.** Approval determines which
    effects may be attempted; the execution environment limits which effects a
    process can perform. Neither substitutes for the other.

Recovery can reconstruct durable facts but cannot recreate expired authority.
A cancellation request is not confirmed settlement. Acceptance is not
application. Any delegated authority must remain within the authority of its
parent. These are product invariants even when the interface uses ordinary
language such as “still active,” “could not confirm completion” or “apply these
changes.”

The [verification reference](verification.md), [architecture](architecture.md)
and [qualification criteria](qualification.md) retain the precise contracts.

## Product, engine and model

Tesota is the product and the agent. Pi is the current agent engine: it provides
session, model-interaction and tool-loop mechanics. A model is one component of
an execution route. Neither Pi nor a particular model is Tesota's identity.

**The work and its evidence can outlive the engine.** Tesota should preserve
the right to change models or engines when a replacement route is justified and
qualified. Changing engines is not itself the product, and the current roadmap
does not promise an engine registry, universal session migration, automatic
model routing, account pools, silent provider failover or a native Tesota
engine.

Pi, Gentle AI and individual verifiers are credited integrations. They do not
gain Tesota-owned authority through integration. The architecture explains the
boundaries among the agent engine, execution environment, verifier and reviewer.

## Audience and measure of success

Tesota is initially for developers and maintainers who want AI assistance while
keeping scope, resulting changes, applicable checks and human decisions
understandable. That audience remains a hypothesis until ordinary use validates
it.

The first useful measure is not feature count. It is whether a person can
complete a worthwhile task with acceptable residual defects and reasonable
setup, intervention, elapsed time and review burden. Later domains need their
own result, evidence, effect and adoption definitions before becoming product
promises.

## Public language

Public introductions lead with what Tesota is, what a person can do with it and
why its evidence relationship matters. Internal lifecycle terms follow only
when a reader needs implementation detail.

The canonical category is **verification-first agent**. In an explicitly
software-development context, **verification-first coding agent** is a valid
domain description, not the product's permanent boundary.

The primary tagline is:

> **Work that carries its evidence.**

For the software-development domain, this contextual line is also valid:

> **Build the change. Keep the evidence.**

Tesota speaks with calm engineering precision. It explains what happened, what
evidence applies and what remains unknown. It does not describe itself as safe,
trusted, autonomous, production-ready or superior without evidence for the
exact claim. The dated [public positioning review](references/public-positioning.md)
records the external comparison behind this language. [Decision 006](decisions/006-public-product-identity.md)
records the original positioning decision, and [decision 010](decisions/010-center-public-docs-on-user-experience.md)
records the experience-first documentation hierarchy.

## Why the name

The name comes from *Olneya tesota*, desert ironwood, also known as *palo
fierro*. This Sonoran Desert tree has dense, durable wood and provides shelter
that helps other plants establish themselves. The botanical reference is
described by the [Arizona-Sonora Desert Museum](https://www.desertmuseum.org/programs/ifnm_ironwoodtree.php).

For the project, it suggests a durable foundation that supports growth. This is
an intended association, not a claim that the software has already achieved
that dependability. Botanical language does not become architecture vocabulary.

Final visual identity, domain selection and social handles remain open.
Professional trademark clearance has not been completed, so current use must
not imply exclusive legal rights to the name.
