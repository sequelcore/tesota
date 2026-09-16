# 010: Center public documentation on the user experience

Status: adopted.

## Context

Tesota's identity already described a verification-first agent, but its public
documentation introduced the implementation through proposals, grants,
candidates, evidence, review and promotion. Those distinctions are necessary
inside the architecture. Presenting them first made the product feel like a
governance system the user operates rather than an agent the user works with.

The Kiln extraction also showed a product risk: infrastructure and scope can
expand faster than demonstrated everyday usefulness. Adding another subsystem
or abstraction layer would not answer whether a person can complete a useful
task through one understandable conversation.

## Decision

Public product documentation follows this hierarchy:

1. what Tesota is;
2. what a person can do with it;
3. why verification-first changes the resulting experience;
4. how to try the currently supported workflow;
5. current limitations; and
6. implementation detail for readers who need it.

The product mental model is:

```text
Ask -> Work <-> Check <-> Correct -> Review -> Apply
```

It is not a mandatory linear ceremony. Read-only work may end with an answer,
checks may occur at several points, and consequential effects retain their own
authority boundaries.

The README owns orientation. `docs/using-tesota.md` owns the complete supported
user workflow. Identity owns the enduring thesis. The roadmap is the sole owner
of current product status and priority, expressed as continuous user
capabilities. Qualification owns the evidence required to advance those
capabilities. Architecture and reference documents retain exact terms such as
grant, candidate, applicability, provenance, settlement and promotion.

Tesota remains the product and Pi remains the current engine. Documentation
preserves Tesota's right to qualify a different model or engine without making
interchangeability a current feature or milestone.

## Consequences

- Internal precision remains available without becoming onboarding vocabulary.
- Public examples must distinguish implemented behavior, the next proof and the
  long-term thesis.
- “Verified” cannot stand alone; summaries expose the checked claim, exact
  result, conditions, unknowns and application state.
- Research and historical references may inform decisions but cannot compete
  with the roadmap for present priority.
- The next major proof is ordinary usefulness on prospectively selected tasks,
  including refusals and failures.

This decision changes documentation hierarchy and product evaluation. It does
not add runtime capability or weaken authority, evidence, confinement, recovery
or adoption invariants.
