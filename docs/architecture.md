# Architecture

Tesota is being built as a local, terminal-first, general-purpose,
verification-first agent harness. The current system
implements a narrow software-development slice: bounded repository discovery,
an approved TypeScript source change in an isolated candidate, explicit evidence,
human review and guarded promotion.

The architecture follows the lifecycle in [identity](identity.md). It does not
define a universal agent, verifier or plugin framework ahead of concrete
consumers. The [general-purpose decision](decisions/012-general-purpose-harness.md)
sets the target; the runtime flow and owner table below describe implemented
behavior.

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
  -> eligible check preview and operator selection
  -> operator approval
  -> CandidateTask (bounded effects in independent checkout)
  -> Pi (model loop and tool calls)
  -> scope-integrity + admitted contained check observations
  -> TaskReview (exact diff and current evidence)
  -> optional one-use SemanticRevision (authority-free R1 lineage)
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
| `cli.ts`, `tesota-shell-command.ts`, `tesota-shell-terminal.ts` | Public commands, session-bound interactive composition and Pi TUI layout |
| `shell-session-store.ts` | Local human transcript, inspection cache and interrupted-session state; no grant or task evidence |
| `repository-discovery.ts` | Bounded read-only view of committed source |
| `integrations/pi-discovery-session.ts` | Pi SDK transcript, explicit read-only tool loadout, persisted cumulative budgets and cancellation settlement |
| `task-proposal-contract.ts` | Model-facing proposal vocabulary and limits |
| `task-proposal.ts` | Durable non-authoritative proposal evidence |
| `proposal-admission.ts` | Supported task policy and immutable run grant |
| `task-contract.ts` | Shared task kind, budgets and grant-derived tool schemas |
| `candidate-checkout.ts` | Independent candidate creation, inspection and lifecycle |
| `repository-check-input.ts` | Bounded regular-file, dependency-installation and JSON observations shared by admitted repository checks |
| `repository-container-process.ts` | Docker client/container settlement shared by the concrete TypeScript and Node-test profiles |
| `repository-typecheck.ts` | Concrete TypeScript profile admission, input binding and result semantics |
| `repository-typecheck-process.ts` | Fixed TypeScript process limits and composition with shared container settlement |
| `repository-typecheck-command.ts` | One-use local approval and CLI composition for the TypeScript profile |
| `repository-node-test.ts`, `repository-node-test-reporter.ts` | Selected Node test admission, bound machine report and fail-closed result semantics |
| `repository-node-test-process.ts` | Fixed Node test process limits and shared container settlement |
| `candidate-task.ts` | Candidate effects, plan binding and composition of scope integrity with every selected concrete check on the same result |
| `task-source.ts` | Bounded blob/worktree representation admission and exact source-target observations for guarded promotion |
| `integrations/pi-task.ts` | Pi execution and correction evidence consistency |
| `task-review.ts` | Exact-candidate review and local decision evidence |
| `semantic-revision.ts` | Bounded authority-free R1 refinement and parent identity |
| `task-promotion.ts` | Accepted-byte validation and guarded source writes |
| `task-start.ts` | Check selection and identity capture before approval, followed by one conversational approval-to-promotion workflow |
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

Each supported shell session has one Pi Coding Agent SDK transcript for
sequential turns. Settled transcripts are stored under Tesota's local state
with cumulative budget entries; an interrupted operation receives a fresh
engine identity on restart. The explicit resource loader disables
ambient extensions, skills, prompt templates, themes and context files. Tesota
supplies only its bounded list, search, read and result tools and replaces the
repository reader on every turn. The explicit `task propose` seam and candidate
runtime continue to use their narrower agent-core integrations. Tesota owns
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

## Pi session integration

The read-only session and its bounded initial task-tool connection are implemented.
The shell workspace restores settled Pi context, but a restored transcript is
not permission to resume an interrupted task or load additional tools. The
[roadmap](roadmap.md) owns subsequent expansion and qualification.

| Concern | Reuse or existing owner |
| --- | --- |
| Transcript and follow-up handling | One Pi Coding Agent SDK session per user session. Settled context and cumulative budgets can be reopened; automatic compaction and retry are disabled. |
| Current task, candidate, check and application facts | Existing Tesota records; conversation summaries may reference but cannot replace them. |
| Resources and tools | Explicitly selected resources and adapters connected to current Tesota authority. |
| Candidate writes and adoption | Existing candidate effects, content binding, review and promotion. |
| Process effects and termination | The admitted execution environment and observed settlement, not merely Pi's terminal event. |

The shell owns a separate prompt and cancellation target for each user session,
with at most two operations active across them. A split view can show another
session read-only; focus and decisions stay with the selected session. Pi TUI
provides the editor, horizontal stacks and scroll views. The session store
keeps human transcript and inspection cache apart from canonical task records.
It does not persist approval or reconstruct a candidate capability. A single
local shell writer owns one repository's session history. Promotion attempts
from its parallel sessions are serialized before the existing source-drift
checks. A changed repository state rotates the Pi context for a new request,
with the prior counters carried forward; clarification baselines still fail
closed. Each session's SDK host wires cancellation to its active inference or
tool operation, waits up to the
settlement bound and returns to the prompt only after settlement is confirmed.
Each discovery turn retains the existing repository operation and exposure limits.
After approval, R0 activates only the admitted read, replace and check tools in
the same SDK transcript. Those tools delegate to the live candidate capability;
the task runner keeps its separate cumulative R0/R1 limits and evidence owner.
Task tools become inactive after R0 settles. The optional semantic correction
still uses a fresh disposable Pi execution. The read-only conversation and its
R0 task turn together admit at most 36 model invocations and 96 tool calls;
discovery additionally admits at most 12 turns. Context overflow ends the engine
conversation clearly; no automatic compaction, provider retry or silent model
switch is enabled. Settled transcript restoration preserves those counters.

Conversation prose has its own formatting contract: paragraphs, tabs and code
blocks pass through to Pi's text renderer; terminal control sequences remain
invalid. Proposal fields retain their separate restrictions. Structured discovery
results still bind evidence to files observed in the current turn; prose itself
does not grant authority. Invalid results, tool failures and budget exhaustion
retain distinct outcomes. After leaving the alternate screen, the shell renders
its final message through Pi so a stopped session leaves an explanation visible.

Pi's project trust and resource settings do not authorize Tesota task effects.
The shell explicitly selects resources because default context and extensions
have different loading rules. Pi does not sandbox the repository checks;
Tesota's admitted execution environment owns that boundary. Restoring a
transcript cannot restore expired tools or approval.
Candidate edits still require current input binding and invalidate affected
evidence; rendered patches do not replace exact accepted bytes at promotion.

## Execution environments

The work model has three independent decisions: **authority** says which
operation and effects the user admitted; **execution environment** says what
the operating system can confine; **verification evidence** says what a check
observed about which exact result. A user approval is not a sandbox, and a
sandbox is not a passing check. Review interprets evidence against the user's
request; acceptance and guarded application remain separate. The current
TypeScript profiles still package their check and Docker environment together.
The [repair sequence](implementation-plan.md#execution-and-evidence-repair-before-another-usefulness-claim)
will separate those decisions for one real task before extracting shared code.

The current repository TypeScript and targeted Node test profiles use a pinned Docker
container because they can load candidate dependencies or execute candidate
tests. Their container policy is part of their bound evidence. The native
Oxlint profile occupies a narrower boundary: it reads a captured source file
through fixed rules, loads no external plugins and executes no candidate code.
Its process settlement is evidence, but it is not described as sandboxing.

Docker is therefore the current protected provider for repository-executing
checks, not a product-wide architectural requirement. The intended ordinary
protected route is a qualified OS-level local sandbox. A qualified container
remains selectable when needed or preferred; a trusted host-native route needs
explicit consent and a grant that permits its lower assurance. Remote
isolation remains deferred until a named workflow requires it.

There is no silent downgrade. If the selected environment becomes unavailable
or cannot confirm settlement, Tesota preserves that outcome instead of running
the operation through a weaker environment. The complete rationale and future
qualification boundary are in
[decision 007](decisions/007-execution-environments.md).

## Current limitations

The original task admits only modifications to one or two existing `src/**/*.ts` files;
the separate source-and-test task admits one existing TypeScript source and one existing regression test.
Its repository-executing
checks currently require the qualified container path; no OS-sandboxed or
trusted host-native repository-task provider is implemented. It does not admit general test changes,
new/deleted files, arbitrary repository commands or projects, general web tools, remote adoption or
untrusted workloads. The [roadmap](roadmap.md) owns the capability sequence;
[qualification](qualification.md) records the evidence required to broaden
those boundaries.

## Intended extension boundary

The current candidate, check, review and promotion contracts are a coding
implementation, not a template that every domain must copy. Future task types
need their own result and effect boundaries. An answer may be reviewed without
file application; a browser action needs observed state and settlement; a
document result needs artifact identity and applicable checks.

An application may eventually host Tesota work while retaining its own users,
domain data and business policy. Tesota would need a bounded way to receive
current authority and context and return results and evidence. That boundary
is proposed, not implemented. A change to the governing objective or
permission must be rechecked before any consequential tool effect; a
post-action review cannot authorize an action retroactively.

Shared evidence should identify the claim, examined result and inputs,
producer, configuration, outcome and limits. Individual methods retain their
own semantics and effect policy. Native and user-supplied methods are opt-in;
reviewers assess the result and evidence fit, while human acceptance stays
separate. Implement a shared contract only when actual methods need it.
Internal compatibility layers are unnecessary because there are no external
consumers. The [roadmap](roadmap.md) owns the sequence.
