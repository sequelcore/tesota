# 007: Keep execution policy independent from its environment

Status: adopted architectural direction. The container-backed repository
profiles, explicit trusted Windows host-local checks, and fixed native Oxlint
profile are implemented. One small host-local end-to-end task is qualified on
Windows; broader usefulness and confinement remain unproved.
The Vitest profile described in this decision was later retired because it had
no task-flow consumer; the TypeScript and targeted Node-test profiles are the
current implementations. The historical rationale below is
retained.

The 2026-09-24 combined-check diagnostic exposed an implementation gap:
Docker was required for the ordinary code path and eleven host checks copied
the same 309 MB dependency installation repeatedly. That is not the intended
general-purpose harness experience. The correction began as a design decision;
its current implementation and qualification status are in the
[implementation plan](https://github.com/sequelcore/tesota/blob/b8d28484f9df46291763c0b44665129d3c1bddb0/docs/implementation-plan.md#execution-and-evidence-repair-before-another-usefulness-claim).

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
universal mechanism. The [public positioning evidence](https://github.com/sequelcore/tesota/blob/b8d28484f9df46291763c0b44665129d3c1bddb0/docs/references/public-positioning.md#execution-environments-and-isolation)
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

The long-term execution flow is policy-first:

```text
approved task and authority
  -> execution requirements
  -> qualified provider selected before execution
  -> provider-specific observation and settlement
  -> exact-result evidence
  -> human review and guarded application
```

Requirements name readable and writable roots, network and credential policy,
process and descendant containment, platform, resources, cancellation and
settlement. Provider selection is not a model decision. A repository-supplied
environment description is untrusted input and cannot expand those requirements.

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

## Environment and verifier inputs

Confinement and verifier-input identity are separate properties. A sandbox
limits what a command can observe or change; it does not by itself establish
which dependency bytes were used. A snapshot or content manifest can bind those
bytes; it does not by itself confine the command. Each profile must state which
properties it requires and retain both in its evidence.

Interactive work should prepare one task-owned environment and bounded
dependency input, then reuse them for that task's checks while binding each
invocation to the current candidate bytes. A new invocation must verify that
the reused dependency input still has its approved content. The environment
and its inputs are not reused after unconfirmed settlement. Cross-task
content-addressed caching is deferred until measurements demonstrate a need
and its poisoning, concurrency, invalidation, recovery and cleanup obligations
have explicit owners.

The shell must remain useful without Docker installed. For repository commands,
the ordinary path should prefer a qualified OS sandbox. When that is unavailable,
the operator may explicitly choose a trusted host-local posture for a named
task and its stated effects, or a qualified container if available. Host-local
consent is separate from approving the candidate's file scope and cannot be
reported as sandboxing. No backend changes silently after approval. An
operation requiring confinement remains unavailable if no qualified protected
environment can run it. Host-local repository code inherits the user's ambient
access and may interfere with the evidence producer or private state; its
checks therefore carry a lower-assurance claim even when their reported
result passes. Consent cannot turn that result into protected evidence.

Verification evidence is a Tesota-issued observation of an actual command,
bound to the candidate bytes, material verifier inputs, invocation, environment
and observed settlement. It is retained outside candidate-writable state. A
candidate-local record or model statement cannot issue its own passing check.
For contained execution, candidate code must not be able to reach the
observation or modify the dependency input; host-local execution instead
carries the explicit assumption that the user's host and executed code are
trusted. A
content digest identifies bytes but cannot authenticate a claim made by code
that could alter the observation store.

Review assesses the observation; acceptance records a human choice; promotion
checks the accepted bytes against the source before writing. Those later stages
validate applicability rather than rerun an unchanged verifier. Changing the
candidate, its configuration, lockfile or check definition can make the prior
observation inapplicable. Changing the original dependency installation after
a settled run does not change the dependency bytes that run actually used, and
deleting its former snapshot does not erase the historical observation. A new
run must check its inputs again. If policy requires equivalence with the source
installation at application time, it must pay for a fresh content comparison
or enforce immutability; file metadata alone is insufficient. A policy may
require repetitions for a specific flaky or probabilistic claim, but that is
an explicit check requirement, not an accidental consequence of calling review
or promotion.

The design should reuse established environment formats without treating them
as authority:

- [OCI](https://opencontainers.org/) image, runtime and distribution
  specifications are the portable container boundary; Docker Desktop is one
  current implementation, not Tesota's durable contract.
- The [Development Container Specification](https://containers.dev/) is a
  reusable description of a local or cloud development environment. Its image,
  mounts, lifecycle commands, network and secrets still require admission under
  Tesota's policy.
- Exact-result records may use the subject, materials, invocation and
  environment concepts from [SLSA provenance](https://slsa.dev/spec/v1.2/provenance)
  without claiming SLSA compliance or replacing Tesota's authority, settlement
  and unknown-state fields.

This direction does not authorize a universal executor, provider registry or
proprietary repository environment format. Those abstractions wait for concrete
consumers and qualified implementations.

## Current application

- At adoption, `typescript-no-emit/v1` and `vitest-targeted/v1` were container-specific
  protected profiles. Docker Desktop and their pinned image were development
  requirements for those profiles, not requirements for Tesota as a product.
- `oxlint-static/v3` remains a fixed native verifier profile. Its bounded input,
  disabled plugins and lack of candidate-code execution make that a different
  risk class; its process boundary is explicitly not described as a sandbox.
- The Windows isolation experiment compares concrete mechanisms but grants no
  task authority and does not create a general backend selector.
- A later [Anthropic Sandbox Runtime Windows follow-up](https://github.com/sequelcore/tesota/blob/b8d28484f9df46291763c0b44665129d3c1bddb0/experiments/isolation/README.md#repository-and-alias-follow-up)
  passed a real TypeScript check and constrained a private fixture, but a
  separate broadly accessible host tree remained reachable. It is not yet a
  qualified protected task provider.

The check lifecycle now reuses a task-owned dependency snapshot and avoids
verifier runs during review and application. The trusted host-local route is
implemented for the fixed TypeScript and targeted Node checks. One ordinary-shell
diagnostic completed without Docker; direct verifier probes alone did not establish
that full task. A host-local pass observes only the direct process exit;
surviving descendants and external host inputs remain assumptions of the
operator-trusted workload. The Docker result remains valid for its exact
environment and does not qualify either local posture.

A native provider must prove exact filesystem roots, external aliases and
reparse points, local and external network policy, inherited credential
exclusion, toolchain access, child-process settlement, cancellation, resource
limits, startup failure and cleanup. Its setup and repeated-check latency are
part of qualification. No provider is selected from documentation claims alone.

## Windows native sandbox candidate (2026-09-24)

**Anthropic Sandbox Runtime (SRT) is the first candidate for the next Windows
native qualification, not a selected protected task provider.** Its standalone
library and CLI already use a dedicated Windows account, filesystem ACLs and a
Windows Filtering Platform network fence. Adapting that mechanism inside
Tesota is preferable to building a Windows sandbox from scratch before a
qualified task needs one. Tesota still owns the admitted effects, provider
selection, observation and evidence; SRT would enforce only the OS boundary.
Being independent of a provider does not require a separate sandbox repository.

The [2026-09-23 probes](https://github.com/sequelcore/tesota/blob/b8d28484f9df46291763c0b44665129d3c1bddb0/experiments/isolation/README.md#repository-and-alias-follow-up)
establish a narrower result. SRT 0.0.77 ran a real TypeScript check and denied
direct and junction access within a private task root. A separate host tree
with broad inherited permissions remained readable and writable. Unlisted
reads match SRT's documented read default; the external write violates
Tesota's proposed strict host-write boundary under that configuration. In a
separate run, combined `denyRead` and `denyWrite` on one file did not preserve
the observed read denial. The resource probe did not establish the proposed
memory cap. These are local observations, not a general verdict on every SRT
configuration or later release. Current upstream ACL code expresses an intent
to retain the stronger overlapping deny, but that source alone does not resolve
the observed behavior; reproduce it against the exact version before claiming
a fix. [SRT configuration and Windows model](https://github.com/anthropics/sandbox-runtime/blob/main/README.md),
[overlap code](https://github.com/anthropics/sandbox-runtime/blob/main/vendor/srt-win-src/src/acl.rs).

The industry comparison does not establish a drop-in replacement. Codex's
[Windows design](https://openai.com/index/building-codex-windows-sandbox/)
deliberately supports broad reads; Gemini CLI's
[native Windows mode](https://geminicli.com/docs/cli/sandbox/) documents
persistent file-integrity changes. These are different contracts, not evidence
that either meets Tesota's exact task policy. SRT labels Windows support alpha,
requires a one-time elevated machine setup, and documents that Windows system
DNS resolution is not fenced. A policy promising no outbound data must test
that path or explicitly admit the DNS exception.

The next qualification must use the same admitted policy and real task that a
Tesota user would run. It must test original files, credentials, dependency
inputs and evidence outside candidate-writable state; ordinary broadly
accessible host trees; direct paths and junctions; overlapping read/write
rules; direct, loopback, IPv4/IPv6 and DNS network paths; child processes,
cancellation, helper or host failure, recovery and concurrent sessions. It
must measure setup and repeated-check time, installed toolchain access and
resource limits. SRT's current
[Windows job code](https://github.com/anthropics/sandbox-runtime/blob/main/vendor/srt-win-src/src/job.rs)
does not establish the required memory, CPU or process caps. Adding an outer
Windows Job Object is only a hypothesis:
[Microsoft's nested-job rules](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs)
constrain composition when UI limits are set. Prove the entire process tree is
bounded before making a resource claim; if a narrow SRT helper change is
needed, prefer an upstream contribution to a parallel sandbox implementation.

If SRT meets the admitted policy, implement its Tesota adapter and qualify the
resulting task flow. If only a narrower policy can be demonstrated, expose that
policy and its limits before approval; never label it as the stricter one or
silently substitute it. Keep Docker selectable for its qualified use and
trusted host-local execution explicitly lower assurance. Defer a standalone
sandbox project until a real second consumer and a maintainable independent
boundary exist.

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
