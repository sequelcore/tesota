# 013: Build the general agent loop first

Status: adopted 2026-09-24. Supersedes the delivery order in
[decision 012](012-general-purpose-harness.md) and its requirement to keep
experimental evidence in the working tree. Narrows how
[decision 011](011-evidence-gated-capabilities.md) applies to the coding loop.

## Context

[Decision 001](001-start-tesota.md) left Kiln because "scope and
infrastructure grew before that everyday workflow became reliable enough to
use", and set a small self-development change as the success criterion.

Tesota still cannot do that. The shell supports two fixed
TypeScript task shapes that edit only existing files and run only fixed
checks. The first slice of the general-purpose plan was still open after about
300 commits in three weeks. Its one successful combined-check run took 64
minutes after three failed attempts. Documentation and experiment records
roughly matched the size of the source. Each capability was bounded, qualified
and documented before anyone could use Tesota for ordinary work. That repeats
the pattern decision 001 was meant to stop.

The core ideas still hold: show the exact result, run checks against that
result, never report a missing or failed check as a pass, and keep acceptance
separate from application. The mistake was the order: every guarantee came
before usefulness.

## Decision

Replace the fixed task shapes with a general coding loop, then put Tesota's
verification around its result:

1. The agent works in an independent checkout of the repository with general
   read, write, create, delete and command tools. Pi's coding-agent tools are
   the starting point.
2. Commands need operator approval, as in other coding agents. Unconfirmed OS
   confinement does not block ordinary use. Protected execution stays
   selectable where it is qualified.
3. When the agent finishes, Tesota shows the final diff, runs the selected
   repository checks on that exact result and asks the operator to accept or
   reject it. Guarded application stays as it is.
4. Tesota is used on its own repository as soon as the loop works. Observed
   failures choose the next work.

Keep from decision 012: the product direction, Tesota-owned result and
evidence contracts, plain-language output and no speculative registries.
Keep from decision 011: capabilities need a real consumer. Drop per-capability
qualification protocols and experiment write-ups as a precondition for coding
work. A short note in [findings](../findings.md) is enough; the detail lives in
Git history.

## Consequences

- Existing task-shape code (proposal admission, fixed task kinds, per-shape
  check selection) is removed in the change that replaces it, not before.
- The agent's intermediate actions carry weaker guarantees than the old
  per-edit grants. The final diff, bound checks, review and guarded
  application carry the trust.
- Live claims describe what was exercised, briefly. They do not need a frozen
  protocol before the work starts.
- The removed `experiments/` records and retired guides remain available at
  commit `b8d28484f9df46291763c0b44665129d3c1bddb0`.

## Implementation note (2026-09-24)

The first implementation removed the Docker check route and the Gentle AI
review integration together with the fixed task shapes. Both existed only
for the TypeScript and Node test profiles, which a general loop cannot reuse.
Checks are now operator-approved repository commands that run without a
sandbox. A protected execution route and an independent reviewer return
through [roadmap](../roadmap.md) step 3, built on the general loop.
