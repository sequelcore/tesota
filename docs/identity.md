# Identity and purpose

**Tesota is an open-source agent for work that carries its evidence.** Describe
what you need, inspect what the agent did and what its checks establish, and
decide whether to use the result. The intended product is a general-purpose
harness that can take on varied tasks through appropriate tools and methods of
verification. The current pre-release implementation supports only bounded
repository questions and TypeScript changes; the [roadmap](roadmap.md)
separates that support from the product direction.

The intended experience is an ordinary conversation:

```text
Ask -> Work <-> Check <-> Correct -> Review -> Apply
```

These are possible stages, not mandatory ceremonies. A repository question can
end with an answer. A change needs scoped approval, a current result and human
review before application. [Using Tesota](using-tesota.md) describes the current
workflow; the [roadmap](roadmap.md) owns status and priority.

## Why verification-first

An agent's answer or completed edit is not proof of correctness. Tesota keeps
four distinctions visible:

1. A check states the property, result and conditions it actually observed.
2. Evidence for an earlier result does not silently apply after that result changes.
3. Unchecked behavior and unresolved effects remain explicit.
4. Checks, human acceptance and application are separate facts.

These distinctions also govern failures. A finding, unavailable tool, timeout,
cancellation and unconfirmed settlement need different outcomes. Recovery can
reconstruct recorded facts but cannot recreate expired authority. Approval
determines which effects may be attempted; the execution environment limits
what a process can do. See [architecture](architecture.md) and
[qualification](qualification.md) for the precise boundaries.

## Product and components

Tesota owns the task scope, evidence, review and application decision. Pi is the
current agent engine for conversation and tool-loop mechanics; Codex is the
configured model route for the supported live flow. Gentle AI is an optional
review provider. None of these integrations grants itself Tesota's authority.
Replacing an engine or model requires qualification of the affected behavior;
an engine registry or universal provider interface is not a product goal.

The intended audience includes people doing coding and non-coding work who want
useful AI assistance while understanding the result and its limits. Success
means completing worthwhile work with acceptable defects, setup, time,
intervention and review effort. Representative use must establish that claim;
a feature list or one successful demonstration cannot. Native and user-supplied
verification and review methods are an opt-in product direction, not a current
general integration capability.

## Public language and name

The category is **general-purpose, verification-first agent harness**;
**verification-first coding agent** describes only the current proving ground.
The primary line
is **Work that carries its evidence.** Claims of safety, trust, autonomy or
production readiness require evidence for the exact claim. The dated
[positioning review](references/public-positioning.md) and
[identity decision](decisions/006-public-product-identity.md) retain the
reasoning behind this language.

Tesota takes its name from *Olneya tesota*, the Sonoran Desert ironwood tree
described by the [Arizona-Sonora Desert Museum](https://www.desertmuseum.org/programs/ifnm_ironwoodtree.php).
The name suggests a durable foundation; it is not a dependability claim or an
architecture term. Trademark clearance has not been completed.
