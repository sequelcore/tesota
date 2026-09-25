# Architecture

**Tesota is an open-source agent for work that carries its evidence.** You
describe what you need, inspect what the agent did and what its checks
establish, and decide whether to use the result. The long-term goal is a
general-purpose harness. Today Tesota handles repository questions and two
fixed TypeScript change shapes. [Decision 013](decisions/013-general-agent-loop-first.md)
replaces those shapes with a general coding loop; the [roadmap](roadmap.md)
tracks that work.

The name comes from *Olneya tesota*, the Sonoran Desert ironwood tree. It is
not a dependability claim. Trademark clearance has not been done.

## Principles

1. A check states what it observed, about which exact result, under which
   conditions.
2. Evidence for an earlier result does not carry over after the result
   changes.
3. Failures, timeouts, cancellations and unconfirmed effects stay distinct.
   None of them becomes a pass.
4. Checks, review, human acceptance and application are separate facts.
5. Model output, a check result and a review never grant authority. Approval
   comes from the operator.
6. Approval permits an operation; the execution environment limits what it can
   actually do. Neither substitutes for the other.

## Components

Tesota owns task scope, result identity, evidence, review and application. Pi
(`@earendil-works/pi-*`) is the agent engine for conversation, tool loops and
the terminal UI. Codex, through Pi's OAuth support, is the only model route
(see [authentication](authentication.md)). Gentle AI is an optional review
provider. None of them grants itself Tesota authority. Replacing the engine or
model needs the affected behavior re-exercised; there is no engine registry.

## Current runtime flow

```text
Tesota Shell
  -> RepositoryDiscovery      read-only view of committed source
  -> TaskProposal             model proposal, no authority
  -> ProposalAdmission        policy + baseline recheck -> immutable grant
  -> check selection and operator approval
  -> CandidateTask            edits in an independent checkout
  -> checks on the final candidate, in the selected environment
  -> TaskReview               exact diff and current evidence
  -> optional SemanticRevision (one correction, fresh checks)
  -> operator decision
  -> TaskPromotion            guarded write back to the repository
```

Supported task shapes:

- **Source-only:** one or two existing non-test `src/**/*.ts` files, checked by
  `typescript-no-emit/v1`.
- **Source and test:** one existing source file and one existing
  `tests/**/*.test.ts` regression test. The test must fail on the original
  source and pass after the repair (`node-test-targeted/v1`). The typecheck can
  also be required.

Both shapes exclude new, deleted or renamed files, dependency and
configuration changes, arbitrary commands and network access. The model cannot
choose or weaken a check. `scope-integrity` always runs. Every task ends in
`human_review_required`.

## Owners

| Owner | Responsibility |
| --- | --- |
| `cli.ts`, `tesota-shell*.ts` | Commands, shell composition, Pi TUI layout and themes |
| `shell-session-store.ts` | Local transcripts and interrupted-session state; no grants |
| `repository-discovery.ts` | Bounded read-only view of committed source |
| `integrations/pi-discovery-session.ts` | Pi SDK session, read-only tools, budgets and cancellation |
| `task-proposal-contract.ts`, `task-proposal.ts` | Proposal vocabulary, limits and stored proposal evidence |
| `proposal-admission.ts`, `task-contract.ts` | Task policy, immutable grant, task kinds and grant-derived tool schemas |
| `candidate-checkout.ts` | Independent candidate creation, inspection and cleanup |
| `candidate-task.ts` | Candidate edits and composition of scope integrity with selected checks |
| `repository-check-input.ts` | File, dependency and JSON observations shared by checks |
| `repository-typecheck*.ts`, `repository-node-test*.ts` | Check profiles, process limits and result semantics |
| `repository-container-process.ts`, `repository-host-process.ts` | Docker and trusted host-local process settlement |
| `integrations/pi-task.ts`, `task-run.ts` | Pi task execution, correction evidence and accounting |
| `task-review.ts`, `semantic-revision.ts` | Exact-candidate review, decisions and the one correction |
| `task-source.ts`, `task-promotion.ts` | Source-target observation and guarded application |
| `task-start.ts` | Check selection before approval, then approval-to-application workflow |
| `task-outcome.ts` | Durable task outcome journal and summary |
| `gentle-review-host.ts` | Optional Gentle review |
| `verification/` | Standalone Oxlint profile and the formal invocation-budget predicate |
| `command-isolation.ts`, `isolation-qualification.ts` | Windows isolation comparison command |
| `live-codex.ts`, `integrations/pi-live*.ts` | Live Codex probe |

## Trust and effects

Repository content and model output are untrusted. Zod schemas validate
input; they do not grant effects. Proposal admission issues the only task
grant after rechecking source identity and paths, and `CandidateTask` derives
its read and write parsers from that grant.

Candidate edits are whole-file replacements bound to the latest observed
SHA-256; concurrent changes close the handle. Application requires a current
accepted review, the same candidate, an unchanged source revision and unchanged
target bytes. Its journal separates preparation from applied writes, so an
uncertain result stays inspectable. Restoring a transcript never restores
approval or tools.

## Checks and execution environments

| Check | Command | Establishes | Does not establish |
| --- | --- | --- | --- |
| `scope-integrity` | automatic | Only admitted paths changed, with supported change types | Behavior |
| `typescript-no-emit/v1` | automatic, or `tesota candidate check typecheck` | The bound candidate passed the fixed no-emit compile | Behavior or completion |
| `node-test-targeted/v1` | automatic (source-and-test) | The approved test passed on the bound candidate after failing on the original | The full suite |
| Oxlint `oxlint-static/v3` | `tesota verify <file>` | Fixed nine-rule static check on one file snapshot | Runtime behavior; not a sandbox |
| LemmaScript/Dafny | `bun run formal:check` | The invocation-budget predicate and its postconditions | Whole-program correctness |
| Gentle AI | `tesota task run gentle-review ...` | One independent review slot for a candidate | Acceptance or correctness |

Repository checks run either in a pinned Docker container (protected) or as a
trusted Windows host process. Host-local checks can reach host files, network
and credentials, and only the direct process exit is observed. The selected
environment is bound before approval and recorded in the evidence. There is no
silent fallback to a weaker environment. Qualifying a native OS sandbox is
still open; see [decision 007](decisions/007-execution-environments.md) and
[findings](findings.md#isolation).

## Pi integration

Each shell session has one Pi Coding Agent SDK transcript. Ambient extensions,
skills, prompt templates, themes and context files are disabled; Tesota
supplies its own list, search, read and result tools. After approval, the same
transcript gets only the admitted read, replace and check tools, which become
inactive when the task turn settles. A conversation and its task turn admit at
most 12 discovery turns, 36 model invocations and 96 tool calls. Automatic
compaction, retry and model switching are disabled. At most two operations run
at once across sessions, and applications to the same repository are
serialized.

## Lower-level commands

The shell composes these; they exist for diagnosis.

```text
tesota task propose <request>      tesota candidate create | list | clean
tesota task start <proposal-id>    tesota candidate inspect <id|dir>
tesota task outcome <proposal-id>  tesota candidate abandon <id|dir>
tesota task review <id|dir>        tesota isolation qualify
tesota task decide <id|dir> <accept|reject> <review-sha256>
tesota task promote <id|dir> <review-sha256>
```
