# Architecture

Tesota is a local, terminal-first, verification-first agent. The current system
implements a narrow software-development slice: bounded repository discovery,
an approved TypeScript source change in an isolated candidate, explicit evidence,
human review and guarded promotion.

The architecture follows the lifecycle in [identity](identity.md). It does not
define a universal agent, verifier or plugin framework ahead of concrete
consumers.

Product documentation uses the human sequence **Ask -> Work <-> Check <->
Correct -> Review -> Apply**. The runtime needs more precise identities and
state transitions:

| User-facing idea | Internal owner |
| --- | --- |
| The work Tesota proposes and the access it needs | proposal admission and an immutable grant |
| This result or this version | candidate identity and content binding |
| Checks for this result | verification applicability and provenance |
| Finished, active or not confirmed finished | outcome journal and settlement state |
| Apply these changes | promotion bound to an accepted candidate |

These terms are necessary for implementation and diagnosis. They are not
prerequisites for ordinary use.

## Runtime flow

```text
Tesota Shell
  -> RepositoryDiscovery (read-only baseline)
  -> TaskProposal (untrusted evidence, authority: none)
  -> ProposalAdmission (current policy and baseline)
  -> operator approval
  -> CandidateTask (bounded effects in independent checkout)
  -> Pi (model loop and tool calls)
  -> scope-integrity + contained TypeScript observations
  -> TaskReview (exact diff and current evidence)
  -> operator decision
  -> TaskPromotion (conflict-safe adoption journal)
```

Authority moves downward from application policy and explicit operator action.
Observations move upward from actual effects. Model output, telemetry, a verifier
result and a review never create authority.

Execution follows a separate chain:

```text
admitted effects and protection requirements
  -> qualified execution environment selected before approval
  -> exact environment and policy shown to the operator
  -> bounded invocation
  -> observed result and settlement bound into evidence
```

Approval permits an operation; the execution environment constrains its actual
effects. A process does not become protected merely because it was approved,
and an isolated process does not gain authority merely because it is confined.

## Canonical owners

| Owner | Responsibility |
| --- | --- |
| `cli.ts`, `tesota-shell-command.ts` | Public commands and interactive composition |
| `repository-discovery.ts` | Bounded read-only view of committed source |
| `task-proposal-contract.ts` | Model-facing proposal vocabulary and limits |
| `task-proposal.ts` | Durable non-authoritative proposal evidence |
| `proposal-admission.ts` | Supported task policy and immutable run grant |
| `task-contract.ts` | Shared task kind, budgets and grant-derived tool schemas |
| `candidate-checkout.ts` | Independent candidate creation, inspection and lifecycle |
| `repository-check-input.ts` | Bounded regular-file, dependency-installation and JSON observations shared by admitted repository checks |
| `repository-container-process.ts` | Docker client/container settlement shared by the concrete TypeScript and Vitest profiles |
| `repository-typecheck.ts` | Concrete TypeScript profile admission, input binding and result semantics |
| `repository-typecheck-process.ts` | Fixed TypeScript process limits and composition with shared container settlement |
| `repository-typecheck-command.ts` | One-use local approval and CLI composition for the TypeScript profile |
| `repository-vitest.ts` | Concrete targeted Vitest profile admission, input binding and result semantics |
| `repository-vitest-process.ts` | Fixed Vitest process limits and composition with shared container settlement |
| `candidate-task.ts` | Candidate effects, plan binding and composition of scope integrity with the concrete TypeScript check |
| `integrations/pi-task.ts` | Pi execution and correction evidence consistency |
| `task-review.ts` | Exact-candidate review and local decision evidence |
| `task-promotion.ts` | Accepted-byte validation and guarded source writes |
| `task-start.ts` | One conversational approval-to-promotion workflow |
| `task-outcome.ts` | Durable non-authoritative task outcome journal, recovery and operator summary |
| `gentle-review-host.ts` | Optional independent Gentle review integration |

Each owner has a present consumer. The task contract contains no Tesota-specific
file path, expected prose or source-code oracle.

## Trust and effect boundaries

Repository contents and model output are untrusted data. Zod schemas validate
runtime inputs, but schemas do not grant effects. Proposal admission constructs
the only current task grant after rechecking source identity and supported paths.
`CandidateTask` derives read and write parsers from that grant and performs each
filesystem effect itself.

Candidate edits are whole-file replacements bound to the latest observed SHA-256.
The first replacement requires a prior check. Concurrent changes close the
handle. Persisted task plans allow inspection and rechecking only; they cannot
reconstruct editing authority.

Promotion is a separate consequential effect. It requires a current accepted
review, the same candidate write-set identity, an unchanged source revision and
unchanged target bytes. Its journal distinguishes preparation from applied
writes so an uncertain result is inspectable.

## Integration boundaries

Pi owns model interaction, session mechanics and tool-call events. Tesota owns
which tools exist, their schemas, budgets and effects. Gentle is an optional
review provider; Tesota preserves provider evidence but keeps acceptance and
promotion local and distinct.

Tesota-owned result and evidence identities do not depend on Pi being the
permanent engine. A future engine or model route must qualify against the same
relevant ownership and evidence boundaries before replacing an existing route.
This preserves the right to evolve the engine without introducing a generic
engine registry or making interchangeability a product feature.

Verifier integrations remain tool-specific. The repository TypeScript profile,
Oxlint and Dafny experiments do not
form a generic verifier abstraction. A new verifier enters the task runtime only
after it has a concrete task consumer and satisfies the qualification policy in
[verifier strategy](verifier-strategy.md).

The admission policy for bounded capability research, including its separation
from runtime adoption, is recorded in
[decision 011](decisions/011-evidence-gated-capabilities.md).

## Execution environments

The current repository TypeScript and Vitest profiles use a pinned Docker
container because they can load candidate dependencies or execute candidate
tests. Their container policy is part of their bound evidence. The native
Oxlint profile occupies a narrower boundary: it reads a captured source file
through fixed rules, loads no external plugins and executes no candidate code.
Its process settlement is evidence, but it is not described as sandboxing.

Docker is therefore the current protected provider for repository-executing
checks, not a product-wide architectural requirement. The intended selection
order is a qualified OS-level local sandbox when it satisfies the admitted
policy, a qualified container when it is required or preferred, and an explicit
trusted host-native posture only for grants that permit its lower assurance.
Remote isolation remains deferred until a named workflow requires it.

There is no silent downgrade. If the selected environment becomes unavailable
or cannot confirm settlement, Tesota preserves that outcome instead of running
the operation through a weaker environment. The complete rationale and future
qualification boundary are in
[decision 007](decisions/007-execution-environments.md).

## Current limitations

The implementation admits only modifications to one or two existing `src/**/*.ts` files. Its repository-executing
checks currently require the qualified container path; no OS-sandboxed or
trusted host-native repository-task provider is implemented. It does not admit test changes,
new/deleted files, arbitrary repository commands or projects, general web tools, remote adoption or
untrusted workloads. The [roadmap](roadmap.md) owns the capability sequence;
[qualification](qualification.md) records the evidence required to broaden
those boundaries.
