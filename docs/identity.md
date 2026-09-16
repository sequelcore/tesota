# Identity and purpose

**Tesota is an open-source, verification-first agent designed to carry work
from intent to an inspectable result, with evidence bound to what it actually
produced.**

> **Work that carries its evidence.**

Software development is Tesota's first proving ground, not the limit of its
identity. Today the implementation is local, terminal-first and intentionally
narrow. The [architecture](architecture.md) describes what exists and the
[roadmap](roadmap.md) records what must be demonstrated next.

## The thesis

AI makes production abundant. Evidence remains scarce.

An agent can produce a persuasive answer, a polished change or a successful
tool transcript without establishing that the result is correct, relevant,
current or authorized to take effect. As agents gain tools and act with less
continuous supervision, that gap matters more: an error can become a filesystem
write, a message, a transaction or another consequential effect.

Tesota starts from a different premise: verification belongs inside the work
loop. Where a requirement can be checked, the check should produce an explicit
observation. A useful diagnostic should guide correction. A corrected result
must receive fresh evidence. The person or policy responsible for adoption must
be able to see what the evidence establishes and what still requires judgment.

The goal is not to make agents infallible. It is to make their work inspectable,
correctable and responsibly adoptable.

## What verification-first means

Verification is broader than formal proof and narrower than a declaration of
quality. Depending on the task, evidence may come from tests, compilers, type
systems, linters, policy checks, simulations, formal methods, independent review
or human assessment. These sources answer different questions and retain their
own limitations.

Tesota follows these principles:

1. **Production is not proof.** Model completion does not establish task
   completion.
2. **Verification is part of execution.** Checks can guide work before the final
   result, not merely reject it afterward.
3. **Diagnostics are useful inputs.** A bounded failure can lead to correction
   and renewed verification.
4. **Evidence has a subject.** An observation identifies the result and relevant
   conditions it describes.
5. **Changed results need renewed evidence.** Old evidence remains historical;
   it does not silently apply to new work.
6. **Different claims need different verifiers.** No single check establishes
   every property of a task.
7. **Evidence informs decisions; it does not create authority.** A passing tool,
   reviewer or model cannot silently approve its own result.
8. **Failure states remain honest.** A finding, unavailable tool, timeout,
   cancellation and uncertain effect are not interchangeable.
9. **Verification is proportional.** The required evidence depends on the work,
   its effects and the cost of being wrong.
10. **Telemetry describes; it does not authorize.** Visibility can improve a
    decision without becoming a permission source.
11. **Authority and confinement are different.** Approval determines which
    effects may be attempted; the execution environment determines which
    effects the process can actually perform. Neither substitutes for the
    other.

The [verifier strategy](verifier-strategy.md) applies these principles to
specific tools and qualification levels. [Decision 007](decisions/007-execution-environments.md)
applies the distinction between authority and confinement to execution
environments.

## The Tesota lifecycle

Tesota owns the relationship between intent, work, result, evidence and
adoption. Engines and tools participate without owning that lifecycle.

```text
intent
  -> admitted work
  -> agent execution
  -> candidate result
  -> applicable verification
  -> evidence and diagnostics
  -> correction when needed
  -> assessment
  -> authorized adoption
```

A **candidate** is the result proposed for assessment or adoption. In the first
software-development domain, it is an exact source state. Other domains may use
different candidate forms, but they must preserve the same essential question:
what exact result does this evidence describe?

## Product scope

Tesota is an agent, not a verifier catalog and not a new foundation model. Its
eventual experience may include conversation, research, planning, tool use,
creation, correction and adoption across more than one kind of work.

Software development is the initial domain because it offers mature external
oracles, consequential effects and concrete adoption boundaries. The intended
developer experience is a normal agent conversation: describe an outcome,
inspect the proposed scope and checks, let the agent work, then assess the exact
change with its applicable evidence and limitations.

The current product does not yet provide that general experience. It supports a
proposal-backed bounded TypeScript source task and qualified experiments. It does not
support arbitrary repository work, general web research, unrestricted commands,
issue publication or general-purpose non-code workflows. Public descriptions
must preserve this distinction between thesis, direction and demonstrated
behavior.

## System roles

The terms below describe different owners and must not be used interchangeably:

| Term | Meaning in Tesota |
| --- | --- |
| **Tesota** | The product and agent that owns the work lifecycle |
| `tesota` | The package and command identifier |
| **Tesota Shell** | The current interactive terminal surface |
| **Agent engine** | Model interaction, sessions, tool calls and agent-loop mechanics; Pi is the selected engine |
| **Model** | The inference provider used by an engine for a particular operation |
| **Execution environment** | The concrete process boundary that applies filesystem, network, credential and process restrictions; it does not grant task authority |
| **Verifier** | A tool that produces a bounded observation about a candidate |
| **Reviewer** | An independent assessor; Gentle AI is the current optional provider |
| **Acceptance** | A human or explicitly authorized policy decision about a candidate |
| **Adoption** | The consequential act that makes an accepted result effective |

Pi, Gentle AI and individual verifiers are credited integrations. None replaces
Tesota's identity, and none gains Tesota-owned authority through integration.
SDD, RDD and TDD are workflows or methodologies, not agent engines.

## Audience and measure of success

Tesota is initially for developers and maintainers who want AI assistance while
keeping scope, checks, resulting changes and human decisions understandable.
That audience is a hypothesis until ordinary use validates it.

The first useful measure is not feature count. It is whether Tesota can produce
an accepted improvement with applicable evidence while making intervention,
elapsed time, observed consumption and unresolved limitations visible. Later
domains need equivalent outcome measures before they become product promises.

## Public language

Public introductions lead with the kind of work Tesota enables, followed by its
evidence relationship. They do not lead with internal state-machine terms.

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
records the external comparison behind this language, and
[decision 006](decisions/006-public-product-identity.md) owns the positioning
decision.

## Why the name

The name comes from *Olneya tesota*, desert ironwood, also known as *palo
fierro*. This Sonoran Desert tree has dense, durable wood and provides shelter
that helps other plants establish themselves. The botanical reference is
described by the [Arizona-Sonora Desert Museum](https://www.desertmuseum.org/programs/ifnm_ironwoodtree.php).

For the project, it suggests a durable foundation that supports growth. This is
an intended association, not a claim that the software has already achieved
that dependability. Botanical language does not become architecture vocabulary.

## Identity work still open

Final visual identity, domain selection and social handles remain open.
Professional trademark clearance has not been completed, so current use must
not imply exclusive legal rights to the name.
