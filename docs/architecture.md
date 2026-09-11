# Architecture

Tesota currently has one private TypeScript package with a verification CLI,
opt-in live integration experiments, and three fixed bounded repository tasks.
It has no general production task runtime or interactive agent shell. The
[roadmap](roadmap.md) describes those intended capabilities separately.

## Implemented ownership

| Owner | Responsibility |
| --- | --- |
| [src/cli.ts](../src/cli.ts) | Dispatch verification, authentication and candidate commands |
| [src/candidate-checkout.ts](../src/candidate-checkout.ts) | Create independent committed checkouts and inspect changes against their baselines |
| [src/candidate-task.ts](../src/candidate-task.ts) | Application-owned documentation task, bounded file operations and exact task check |
| [src/auth.ts](../src/auth.ts) | Login, offline status and local logout |
| [integrations/codex-credentials.ts](../src/integrations/codex-credentials.ts) | Private Codex credential persistence and serialized mutation |
| [verification/oxlint.ts](../src/verification/oxlint.ts) | Run Oxlint, issue result identity and assess applicability |
| [verification/oxlint-input.ts](../src/verification/oxlint-input.ts) | Capture source, fixed configuration and observed verifier identity |
| [verification/oxlint-result.ts](../src/verification/oxlint-result.ts) | Interpret the bounded result contract |
| [verification/evidence.ts](../src/verification/evidence.ts) | Save issued results and validate recovered historical evidence |
| [verification/candidate.ts](../src/verification/candidate.ts) | Isolated one-file candidate, bounded replacement and check ordering |
| [integrations/pi.ts](../src/integrations/pi.ts) | Shared bounded verification admission, Pi session limits and synthetic scenarios |
| [integrations/pi-live.ts](../src/integrations/pi-live.ts) | Live login interaction, model-turn limits and observed outcomes |
| [integrations/pi-live-evidence.ts](../src/integrations/pi-live-evidence.ts) | Capture implementation identity and serialize sanitized live evidence |
| [src/live-codex.ts](../src/live-codex.ts) | Select experiment mode, present authentication, reserve output and bound process lifetime |
| [src/live-verification.ts](../src/live-verification.ts) | Run the fixed live verification fixture and retain issued evidence |
| [integrations/pi-verification-evidence.ts](../src/integrations/pi-verification-evidence.ts) | Verification and candidate probe criteria, identity and sanitized records |
| [src/live-candidate.ts](../src/live-candidate.ts) | Run the correction exercise and retain checks, source and review diff |
| [integrations/pi-task.ts](../src/integrations/pi-task.ts) | Adapt task-owned schemas to Pi tools; bound the live session and observe check continuation |
| [task-run.ts](../src/task-run.ts) | Create one fresh task attempt, reuse authentication and retain its checks and review diff |
| [task-review.ts](../src/task-review.ts) | Review current candidate bytes and bind a separate local operator decision to their fingerprint |
| [task-promotion.ts](../src/task-promotion.ts) | Apply one explicitly requested, accepted paragraph change after source checks; retain the write outcome |
| [code-task-check.ts](../src/code-task-check.ts) | Run the fixed pure-predicate behavior oracle in a pinned, network-disabled container |
| [formal-task-check.ts](../src/formal-task-check.ts) | Seed and check the bounded LemmaScript/Dafny correction task in a temporary copy |
| [verification/invocation-admission.ts](../src/verification/invocation-admission.ts) | Own the pure bounded-invocation decision and its LemmaScript/Dafny contract |

The verification modules have no Pi dependency. Synthetic and live verification
share the same adapter and verifier. The authentication/turn probes have no
executable tools; the separate [verification experiment](../experiments/codex/verification.md)
admits one fixed fixture check.
The [candidate correction exercise](../experiments/codex/candidate.md) uses the
same adapter with one bounded replacement between two checks. Candidate files
are never executed. The scoped documentation task has an explicit guarded
paragraph-promotion command; the code task has a sandboxed behavior oracle and
does not support promotion.

## Engine boundary

Pi supplies agent mechanics, provider transport and authentication. Tesota uses
the public APIs of the pinned `pi-agent-core` and `pi-ai` packages; it does not
install the full Pi coding-agent application. Integration types remain inside
the adapters instead of defining Tesota's verification contract. Experiment guides
and evidence live under [experiments/](../experiments/README.md).

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
Gentle AI is a potential external review provider consumed through an adapter;
it is not Tesota's shell, authority store or acceptance mechanism. If adopted,
the adapter will translate Tesota's candidate and evidence contracts to the
negotiated Gentle review contract and return provider evidence without copying
Gentle's commands, state model or roadmap into Tesota.

The responsibilities remain separate:

| Check or surface | Responsibility | Limitation |
| --- | --- | --- |
| Oxlint | Static source and rule diagnostics | Does not establish semantic intent or integration behavior |
| Gentle review | Independent, bounded review of a candidate and its integration | Does not prove properties mathematically or authorize delivery |
| LemmaScript/Dafny | Proof of explicitly expressed properties | Does not cover omitted requirements or real integration wiring |
| Integration tests | Exercise the connected runtime boundary | Do not replace formal proof of the covered predicate |
| Tesota | Bind candidate identity, evidence, budgets and acceptance policy | Remains the sole owner of promotion authority |

No Gentle integration is implemented or required yet. Qualification must first
verify the exact provider contract, candidate identity, recovery behavior and
evidence retention while preserving Tesota's authority boundaries.

## Static-analysis policy

Tesota's current Oxlint profile is intentionally smaller than Kiln's `dev`
profile. Kiln's profile is a useful source of candidate rules and includes
structural limits and TypeScript safety checks, but it does not detect “slop” as
a semantic category. Tesota will recover rules selectively, with a pinned
configuration and evidence identity, only when a concrete defect pattern and
acceptable false-positive cost have been demonstrated. Gentle review, formal
contracts and integration tests remain responsible for concerns Oxlint cannot
establish.

## Failure and recovery boundaries

An abort request is not observed cancellation. Pi's terminal events determine
the adapter's outcome; missing settlement stays unconfirmed. Active Oxlint
subprocess cancellation through Pi remains unsupported. The verifier has its own
timeout and termination-observation contract.

Verification storage supports coordinated single-writer replacement with bounded
reads. It does not promise locking, power-loss durability or authenticated records.
Live evidence is a separate diagnostic format with exclusive output reservation
and source/build hashes. Neither format establishes human acceptance.

The current verifier's temporary snapshot is not a general sandbox. Future
candidate editing and execution require their own implemented boundaries; a Git
worktree alone would not provide security isolation.
