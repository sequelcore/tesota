# 007: Keep execution policy independent from its environment

Status: adopted architectural direction. Only the current container-backed
repository profiles and the fixed native Oxlint profile are implemented.

## Context

Tesota must run tools whose effects differ materially. The current Oxlint
profile reads a captured source file through a fixed configuration without
plugins or candidate-code execution. Repository typecheck and Vitest profiles
load candidate dependencies, compiler code or tests, so a successful process
can still affect the host unless the execution environment constrains it.

The first protected repository profiles use a pinned Docker container. That
gave Tesota one concrete boundary whose filesystem, network, credential,
process and settlement behavior could be inspected. Making Docker a permanent
product prerequisite would confuse that implementation with the policy it
currently enforces. Conversely, running repository code directly on the host
and attaching a weaker label would not preserve the same guarantee: the code
could modify files outside the candidate, inspect ambient credentials, start
descendants or interfere with the evidence producer itself.

Current agent products expose several execution environments rather than one
universal mechanism. The [public positioning evidence](../references/public-positioning.md#execution-environments-and-isolation)
records the primary sources behind this decision. Those products demonstrate
available mechanisms, not that their boundaries are equivalent or sufficient
for Tesota.

## Decision

Tesota owns the **execution requirements, selection policy and resulting
evidence**. It does not define its product identity around Docker or any other
single execution environment.

An admitted check or task must state the effects it requires and the protection
its policy requires. Before approval, Tesota selects a concrete, qualified
execution environment and exposes that choice. Evidence records the environment,
policy identity and observed settlement that actually applied.

The architecture may support these execution postures when each has a concrete
consumer and qualification evidence:

1. **OS-sandboxed local execution** is the intended low-friction local default
   when the platform can enforce the required filesystem, network, credential
   and process restrictions.
2. **Containerized local execution** remains a protected option for portability,
   reproducibility and workloads whose dependency or process boundary benefits
   from a container.
3. **Trusted host-native execution** may be offered only through an explicit
   lower-assurance policy for selected workloads. It is not equivalent to a
   protected environment and cannot satisfy a grant that requires confinement.
4. **Remote isolated execution** remains a future option for unattended or
   higher-risk work. It requires a named product consumer before Tesota owns
   remote lifecycle, credentials or infrastructure.

Selection fails closed. If no qualified environment satisfies the admitted
policy, the operation is unavailable. Tesota must not silently fall back from a
protected environment to trusted host-native execution, including after setup,
startup or settlement failure.

Environment evidence must describe the dimensions that matter to the admitted
operation rather than collapse them into a generic `safe` or `sandboxed` flag:

- filesystem visibility and writable locations;
- network policy and observed enforcement;
- environment and credential exposure;
- process and descendant containment;
- platform, runtime and relevant dependency identity;
- resource limits, cancellation and terminal settlement;
- the exact policy and provider used for the invocation.

These are conceptual requirements, not a new generic runner schema. Shared code
is introduced only after a second implemented provider exposes stable common
semantics.

## Current application

- `typescript-no-emit/v1` and `vitest-targeted/v1` remain container-specific
  protected profiles. Docker Desktop and their pinned image are current
  development requirements for those profiles, not requirements for Tesota as
  a product.
- `oxlint-static/v3` remains a fixed native verifier profile. Its bounded input,
  disabled plugins and lack of candidate-code execution make that a different
  risk class; its process boundary is explicitly not described as a sandbox.
- The Windows isolation experiment compares concrete mechanisms but grants no
  task authority and does not create a general backend selector.

The next implementation question is whether an OS-level local sandbox can
satisfy one existing repository profile with less setup friction while retaining
the profile's required evidence. Tesota will qualify that concrete provider
before extracting a shared execution abstraction.

## Rejected alternatives

- **Require Docker for all Tesota work.** This would make one qualified provider
  a permanent product constraint and impose unnecessary setup on lower-risk
  operations.
- **Run locally by default and disclose it afterward.** Disclosure does not
  prevent host effects or protect evidence integrity.
- **Automatically use whatever backend is available.** Availability is not
  policy equivalence; silent fallback would invalidate the operator's approval.
- **Build a universal execution framework now.** One container implementation
  and one materially different native verifier do not establish a stable shared
  contract.

## Consequences

Documentation and interfaces distinguish the current backend from the
long-term product contract. Future check profiles declare requirements without
promising that every environment can satisfy them. Operator-facing approval
shows meaningful protection differences, while durable evidence preserves the
actual environment and any unresolved limitation.

Docker remains supported where it earns its cost. It is neither removed to
imitate less constrained agents nor imposed where its protection is not needed.
