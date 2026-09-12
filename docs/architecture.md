# Architecture

Tesota currently has one private TypeScript package with a verification CLI,
opt-in live integration experiments, and five registered bounded repository tasks.
It has a first interactive shell for one natural-language discovery request, but
no general production task runtime or proposal execution. The [roadmap](roadmap.md)
describes those intended capabilities separately.

## Implemented ownership

| Owner | Responsibility |
| --- | --- |
| [src/cli.ts](../src/cli.ts) | Dispatch the interactive entry point, verification, authentication and candidate commands |
| [src/native-shell.ts](../src/native-shell.ts) | Own the first inline terminal prompt and route one message to bounded repository discovery |
| [src/conversation-turn.ts](../src/conversation-turn.ts) | Own valid read-only turn outcomes, live setup and operator-facing result formatting |
| [src/conversation-turn-contract.ts](../src/conversation-turn-contract.ts) | Parse the answer, clarification and task-proposal result variants |
| [src/candidate-checkout.ts](../src/candidate-checkout.ts) | Create independent committed checkouts and inspect changes against their baselines |
| [src/repository-git.ts](../src/repository-git.ts) | Run fixed shell-free local Git operations without ambient config, hooks, credentials or network protocols |
| [src/repository-discovery.ts](../src/repository-discovery.ts) | Expose a bounded committed repository view and validate evidence paths for read-only turns |
| [src/task-proposal-contract.ts](../src/task-proposal-contract.ts) | Own proposal vocabulary, tool request schemas, declarative check IDs and discovery limits |
| [src/task-proposal.ts](../src/task-proposal.ts) | Classify dirty conflicts and retain non-authoritative proposals |
| [src/candidate-task-definition.ts](../src/candidate-task-definition.ts) | Own registered task requirements, read/write sets, oracles, instructions, limits and promotion policy |
| [src/candidate-task.ts](../src/candidate-task.ts) | Enforce a selected registered task through bounded per-file operations and write-set-bound checks |
| [src/auth.ts](../src/auth.ts) | Login, offline status and local logout |
| [integrations/codex-credentials.ts](../src/integrations/codex-credentials.ts) | Private Codex credential persistence and serialized mutation |
| [verification/oxlint.ts](../src/verification/oxlint.ts) | Run Oxlint, issue result identity and assess applicability |
| [verification/oxlint-input.ts](../src/verification/oxlint-input.ts) | Capture source, fixed configuration and observed verifier identity |
| [verification/oxlint-result.ts](../src/verification/oxlint-result.ts) | Interpret the bounded result contract |
| [verification/evidence.ts](../src/verification/evidence.ts) | Save issued results and validate recovered historical evidence |
| [verification/candidate.ts](../src/verification/candidate.ts) | Isolated one-file candidate, bounded replacement and check ordering |
| [integrations/pi.ts](../src/integrations/pi.ts) | Shared bounded verification admission, Pi session limits and synthetic scenarios |
| [integrations/pi-live.ts](../src/integrations/pi-live.ts) | Live login interaction, model-turn limits and observed outcomes |
| [integrations/pi-coding-agent.ts](../src/integrations/pi-coding-agent.ts) | Time-bounded Pi Coding Agent SDK host with Tesota-owned credentials and read/edit tools |
| [integrations/pi-live-evidence.ts](../src/integrations/pi-live-evidence.ts) | Capture implementation identity and serialize sanitized live evidence |
| [src/live-codex.ts](../src/live-codex.ts) | Select experiment mode, present authentication, reserve output and bound process lifetime |
| [src/live-verification.ts](../src/live-verification.ts) | Run the fixed live verification fixture and retain issued evidence |
| [integrations/pi-verification-evidence.ts](../src/integrations/pi-verification-evidence.ts) | Verification and candidate probe criteria, identity and sanitized records |
| [src/live-candidate.ts](../src/live-candidate.ts) | Run the correction exercise and retain checks, source and review diff |
| [integrations/pi-task.ts](../src/integrations/pi-task.ts) | Adapt task-owned schemas to Pi tools; bound the live session and observe check continuation |
| [integrations/pi-discovery.ts](../src/integrations/pi-discovery.ts) | Expose bounded list, literal-search, baseline-read and result-submission tools to Pi |
| [src/pi-review-relay.ts](../src/pi-review-relay.ts) | Expose Tesota's saved Codex OAuth through Gentle's fixed tool-free Pi process transport |
| [task-run.ts](../src/task-run.ts) | Create fresh task attempts or validated recovery successors, reuse authentication and retain checks and review diffs |
| [task-review.ts](../src/task-review.ts) | Review current candidate bytes and bind a separate local operator decision to their fingerprint |
| [task-promotion.ts](../src/task-promotion.ts) | Preflight and apply one explicitly requested, accepted registered write set; retain complete or partial outcomes |
| [code-task-check.ts](../src/code-task-check.ts) | Run the fixed pure-predicate behavior oracle in a pinned, network-disabled container |
| [formal-task-check.ts](../src/formal-task-check.ts) | Seed and check the bounded LemmaScript/Dafny correction task in a temporary copy |
| [candidate-source-task-check.ts](../src/candidate-source-task-check.ts) | Seed and check optional-final-LF candidate-source acceptance |
| [multi-file-task-check.ts](../src/multi-file-task-check.ts) | Derive and check the exact two-file documentation change for the task capability |
| [verification/invocation-admission.ts](../src/verification/invocation-admission.ts) | Own the pure bounded-invocation decision and its LemmaScript/Dafny contract |

The verification modules have no Pi dependency. Synthetic and live verification
share the same adapter and verifier. The authentication/turn probes have no
executable tools; the separate [verification experiment](../experiments/codex/verification.md)
admits one fixed fixture check.
The [candidate correction exercise](../experiments/codex/candidate.md) uses the
same adapter with one bounded replacement between two checks. Candidate files
are never executed. Registered definitions supply scope and oracle data to the
shared task engine; persisted plans cannot add definitions or expand paths. The
promotable definitions support guarded write-set promotion; the formal and
candidate-source tasks do not.

Repository discovery is a separate read-only boundary. It observes committed Git
blobs without creating a candidate and gives Pi no edit, shell, check, web or
arbitrary network tool. A conversational turn must submit exactly one parsed
`answer`, `clarification` or `task_proposal`. Answers cite observed baseline files;
proposed writes must be fully read. Only the proposal variant is retained. Its
version 1 record has `authority: "none"` and no reader or execution consumer. The
configured provider call is inference transport, not model-controlled repository
network access. See the
[proposal contract](proposals.md).

The native shell currently collects one message and invokes that discovery
boundary. It does not continue after an answer or clarification, parse retained
proposal files, grant authority, create a
candidate, approve work or execute checks. When standard input, output or error is
not an interactive terminal, the argument-free CLI preserves the non-inferential
help behavior.

## Engine boundary

Pi supplies agent mechanics, provider transport and authentication. Tesota uses
the public APIs of the pinned `pi-agent-core`, `pi-ai` and
`pi-coding-agent` packages. The coding-agent host is time-bounded and exposes
only the read/edit tools required by its caller; it never commits, promotes or
grants acceptance authority. Integration types remain inside the adapters
instead of defining Tesota's verification contract. Experiment guides and
evidence live under [experiments/](../experiments/README.md).

For live authentication, Tesota calls `Models.login` and handles its public
interaction. Pi owns authorization requests, polling, exchange and refresh.
Tesota supplies a private persistent `CredentialStore`, selects the interaction,
limits its lifetime and controls what is displayed or retained. It does not
implement a second OAuth protocol. See [authentication](authentication.md) for
storage and concurrency, and the [Pi decision](decisions/002-use-pi.md) for rationale.

## Verification and authority

The implemented CLI verifies one captured JavaScript or TypeScript file using
a fixed native-rule profile. Its exact byte snapshot and relevant inputs bind
the result to what was checked. A later comparison can find the evidence
applicable, stale or unavailable; the historical check outcome remains separate.

Issued in-process result identity and recovered evidence provenance are distinct.
Loading a valid record does not grant it issuance authority. The persistence
store validates structure, while the verifier owns input comparison. These
modules cooperate within one verification context; they do not form a generic
storage or attestation framework. See the [verification contract](verification.md).

The Pi adapter validates and admits a verification request before invoking
the shared executor. Pi receives a small result projection; canonical evidence
stays with Tesota. Model output cannot grant verification authority or human
acceptance. Current experiments return `taskAcceptance: "not_evaluated"`.

## Review provider boundary

Tesota owns the operator surface and the decision to accept or promote work.
Gentle AI is an external review provider consumed through a bounded adapter; it
is not Tesota's shell, authority store or acceptance mechanism. The adapter
translates Tesota's candidate and evidence contracts to the negotiated Gentle
review contract and returns provider evidence without copying Gentle's commands,
state model or roadmap into Tesota.

The responsibilities remain separate:

| Check or surface | Responsibility | Limitation |
| --- | --- | --- |
| Oxlint | Static source and rule diagnostics | Does not establish semantic intent or integration behavior |
| Gentle review | Independent, bounded review of a candidate and its integration | Does not prove properties mathematically or authorize delivery |
| LemmaScript/Dafny | Proof of explicitly expressed properties | Does not cover omitted requirements or real integration wiring |
| Integration tests | Exercise the connected runtime boundary | Do not replace formal proof of the covered predicate |
| Tesota | Bind candidate identity, evidence, budgets and acceptance policy | Remains the sole owner of promotion authority |

The Codex-backed Gentle relay is implemented as a bounded transport surface.
Gentle remains the owner of review state, immutable repository context,
reviewer prompts, result schemas and admission. Tesota asks the package-local
Gentle executable for the current transition, validates its lineage, target,
subject and exact argument tokens, and passes the materialized prompt unchanged
to a tool-free Pi model invocation using Tesota's `CodexCredentials`. Before
submission it asks Gentle for status again and refuses a changed binding. The
opaque result is staged with private permissions, submitted through the one
provider-issued value slot and removed afterward. This surface does not edit
candidate files, accept promotion or reconstruct provider authority.
If model transport fails before producing an artifact, the relay performs no
submission or follow-up status call. A later explicit invocation must begin from
fresh provider status; only a slot reoffered there remains usable.
For provider-owned targeted validation, the compiled Pi process relay accepts
only Gentle's fixed no-tools argument vector, bounds stdin, invokes the same
Tesota-owned OAuth reviewer and writes only its opaque result bytes. Gentle still
owns prompt materialization, isolated execution, result admission and closure.

## Static-analysis policy

Tesota's `oxlint-static/v3` profile is intentionally smaller than Kiln's `dev`
profile. It owns nine file-local rules: the original debugger and unused-value
checks, five qualified Kiln rules, and two native rules selected from the
low-evidence patterns described by `anti-slop`. No external plugin or copied
rule implementation is part of the verifier. The complete Kiln profile was not
adopted: its structural limits produced high noise on the current repository,
and Oxlint does not detect “slop” as a semantic category.
Each later rule addition requires a concrete defect pattern, an acceptable
false-positive cost and a new pinned configuration identity. Gentle review,
formal contracts and integration tests remain responsible for concerns Oxlint
cannot establish.

Cyclomatic complexity is a repository-maintainability gate, not part of the
candidate verifier profile and not evidence of task acceptance. The
repository-owned Oxlint configuration enforces the classic variant at maximum
20 across `src` and `tests`, without baselines or file exceptions. Refactored
helpers remain beside their owning behavior; candidate verification continues
to use its own fixed, identity-bound `oxlint-static/v3` configuration.

## Failure and recovery boundaries

An abort request is not observed cancellation. Pi's terminal events determine
the adapter's outcome; missing settlement stays unconfirmed. Active Oxlint
subprocess cancellation through Pi remains unsupported. The verifier has its own
timeout and termination-observation contract.

Verification storage supports coordinated single-writer replacement with bounded
reads. It does not promise locking, power-loss durability or authenticated records.
Live evidence is a separate diagnostic format with exclusive output reservation
and source/build hashes. Neither format establishes human acceptance.

Task recovery validates an undecided failed or incomplete attempt, its current
registered task plan and scope, then creates a clean successor from the
predecessor's exact committed baseline. The explicit command grants a new bounded
handle; it does not resume the old Pi session, copy partial working bytes or
inherit checks, decisions or promotion authority. The predecessor remains intact.

The current verifier's temporary snapshot is not a general sandbox. Registered
candidate editing has its own fixed scope and effect boundaries; arbitrary code
execution would require a separate implemented isolation boundary because a Git
worktree alone does not provide one.
