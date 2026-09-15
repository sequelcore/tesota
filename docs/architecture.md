# Architecture

Tesota is a local, terminal-first, verification-first agent. The current system
implements a narrow software-development slice: bounded repository discovery,
an approved TypeScript source change in an isolated candidate, explicit evidence,
human review and guarded promotion.

The architecture follows the lifecycle in [identity](identity.md). It does not
define a universal agent, verifier or plugin framework ahead of concrete
consumers.

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
| `repository-typecheck.ts` | Concrete TypeScript profile admission, input binding and result semantics |
| `repository-typecheck-process.ts` | Docker client/container settlement and bounded output for that concrete profile |
| `repository-typecheck-command.ts` | One-use local approval and CLI composition for the TypeScript profile |
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

Verifier integrations remain tool-specific. The repository TypeScript profile,
Oxlint and Dafny experiments do not
form a generic verifier abstraction. A new verifier enters the task runtime only
after it has a concrete task consumer and satisfies the qualification policy in
[verifier strategy](verifier-strategy.md).

## Current limitations

The implementation admits only modifications to one or two existing `src/**/*.ts` files. It does not admit test changes,
new/deleted files, arbitrary repository commands or projects, general web tools, remote adoption or
untrusted workloads. The [roadmap](roadmap.md) records the evidence required to
broaden those boundaries.
