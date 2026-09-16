# 006: Present Tesota as a verification-first agent

Status: adopted public category and tagline. The message hierarchy is refined
by [decision 010](010-center-public-docs-on-user-experience.md). Visual identity
and trademark clearance remain open.

## Context

Agent products increasingly present themselves through breadth: more models,
surfaces, background execution, parallel agents, extensions and automation.
Those capabilities are useful, but they do not give Tesota a clear reason to
exist. Describing Tesota primarily as local, open source, safe, governed or
composable would either enter an already crowded position or make a stronger
claim than current evidence supports.

Tesota has a more specific center. It keeps intent, admitted work, the produced
candidate, executable observations, review, acceptance and adoption distinct
but connected. An agent engine, reviewer and task-specific verifiers can
participate without becoming the owner of that lifecycle.

Software development is the first proving ground. Making **coding agent** the
permanent product category would unnecessarily exclude research, operations,
documentation and other future work whose results can carry applicable
evidence. Calling Tesota a general-purpose agent today would make an unsupported
capability claim.

The [public positioning review](../references/public-positioning.md) compares
this focus with current first-party descriptions of representative agents. It
establishes market language and product emphasis, not comparative quality or
feature absence.

## Decision

Use **verification-first agent** as Tesota's canonical public category.

Use this one-sentence description:

> Tesota is an open-source, verification-first agent designed to carry work
> from intent to an inspectable result, with evidence bound to what it actually
> produced.

Use this primary tagline:

> **Work that carries its evidence.**

In an explicitly software-development context, **verification-first coding
agent** and the following line are valid domain translations:

> **Build the change. Keep the evidence.**

Public surfaces must state that software development is the first proving
ground and distinguish the long-term thesis from the current pre-release,
bounded implementation.

## Original message hierarchy

Public communication follows this order:

1. **Outcome:** useful work presented as an inspectable result.
2. **Differentiator:** applicable evidence remains bound to what was produced.
3. **Experience:** intent, execution, verification, correction and adoption form
   one understandable lifecycle.
4. **First domain:** software development supplies the initial tasks, candidates
   and external oracles.
5. **Architecture:** Tesota composes an agent engine, reviewers and tool-specific
   verifiers behind explicit boundaries.
6. **Maturity:** pre-release, narrow task coverage and no stable API.

Architecture supports the claim but is not the opening pitch. Terms such as
authority revision, lineage and settlement belong in technical documentation
when the reader needs them.

Decision 010 later moves the ordinary agent experience ahead of outcome and
mechanism language while preserving this category, tagline and claim boundary.

## Voice and claims

Tesota speaks with calm engineering precision. Public copy is direct, specific
and candid about limitations. It prefers observable behavior over claims such
as safe, trusted, reliable, autonomous or production-ready unless the relevant
evidence owner supports the exact wording.

The position does not claim that other agents lack tests, approvals, diffs,
sandboxing, review or formal methods. It claims that Tesota makes the integrity
of the work-to-evidence-to-adoption path its organizing principle.

## Product and component names

- **Tesota** is the product and agent.
- `tesota` is the package and command identifier.
- **Tesota Shell** is the current interactive terminal surface.
- **Pi** is the selected agent engine, not Tesota's public identity.
- **Gentle AI** is an optional review provider.
- Oxlint, Dafny and future tools are verifier integrations, not product modes.
- SDD, RDD and TDD are workflows or methodologies, not runtime providers.

## Rejected positions

- **The safest agent:** unsupported absolute comparison.
- **A general-purpose agent today:** unsupported current-capability claim.
- **A coding-only agent:** unnecessarily restricts the long-term thesis.
- **A universal agent framework:** suggests infrastructure breadth instead of a
  coherent product experience.
- **An AI verifier:** too narrow; Tesota performs and composes work as well as
  verification.
- **A model-agnostic agent:** replacement remains possible, but model breadth is
  not the current product promise.
- **An autonomous team:** not implemented and contrary to the initial
  one-operator, one-active-writer boundary.
- **A wrapper around Pi or Gentle AI:** incorrect ownership; those are providers
  inside a Tesota-owned lifecycle.

## Consequences

README, package metadata and future website copy use the canonical category and
description. Software-development guides may use the narrower domain wording
when its context is explicit.

Public demonstrations should show one intent moving to an exact result, its
applicable evidence and a human decision. Provider grids, verifier counts and
internal state diagrams are secondary.

The name still requires professional trademark, domain and social-handle
clearance before an irreversible public launch. A preliminary web search is not
legal clearance.
