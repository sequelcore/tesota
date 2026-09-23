# Identity and purpose

**Tesota is a verification-first agent for work that carries its evidence.**
Describe what you need, inspect the result and its applicable checks, and decide
whether to use it. Software development is its first proving ground. Research,
planning and other consequential work remain a long-term direction, not current
capabilities.

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

The initial audience is developers and maintainers who want useful AI assistance
while understanding the resulting changes and their limits. Success means
completing worthwhile work with acceptable defects, setup, time, intervention
and review effort. Representative use must establish that claim; a feature list
or one successful demonstration cannot.

## Public language and name

The category is **verification-first agent**; **verification-first coding agent**
is suitable when discussing the software-development domain. The primary line
is **Work that carries its evidence.** Claims of safety, trust, autonomy or
production readiness require evidence for the exact claim. The dated
[positioning review](references/public-positioning.md) and
[identity decision](decisions/006-public-product-identity.md) retain the
reasoning behind this language.

Tesota takes its name from *Olneya tesota*, the Sonoran Desert ironwood tree
described by the [Arizona-Sonora Desert Museum](https://www.desertmuseum.org/programs/ifnm_ironwoodtree.php).
The name suggests a durable foundation; it is not a dependability claim or an
architecture term. Trademark clearance has not been completed.
