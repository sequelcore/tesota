# Architecture

Tesota currently has one private TypeScript package with two entry points: the
verification CLI and an opt-in live integration experiment. There is no production
task runtime, interactive agent shell or stable/candidate promotion mechanism yet.
The [roadmap](roadmap.md) describes those intended capabilities separately.

## Implemented ownership

| Owner | Responsibility |
| --- | --- |
| [src/cli.ts](../src/cli.ts) | Parse the fixed CLI, select trusted verifier configuration and render results |
| [verification/oxlint.ts](../src/verification/oxlint.ts) | Run Oxlint, issue result identity and assess applicability |
| [verification/oxlint-input.ts](../src/verification/oxlint-input.ts) | Capture source, fixed configuration and observed verifier identity |
| [verification/oxlint-result.ts](../src/verification/oxlint-result.ts) | Interpret the bounded result contract |
| [verification/evidence.ts](../src/verification/evidence.ts) | Save issued results and validate recovered historical evidence |
| [integrations/pi.ts](../src/integrations/pi.ts) | Synthetic Pi scenarios with bounded verification admission |
| [integrations/pi-live.ts](../src/integrations/pi-live.ts) | Live login interaction, model-turn limits and observed outcomes |
| [integrations/pi-live-evidence.ts](../src/integrations/pi-live-evidence.ts) | Capture implementation identity and serialize sanitized live evidence |
| [src/live-codex.ts](../src/live-codex.ts) | Select experiment mode, present authentication, reserve output and bound process lifetime |

The verification modules have no Pi dependency. The synthetic adapter consumes
the existing verifier rather than implementing another one. The live experiment
has no executable tools and does not yet connect a real model to verification.

## Engine boundary

Pi supplies agent mechanics, provider transport and authentication. Tesota uses
the public APIs of the pinned `pi-agent-core` and `pi-ai` packages; it does not
install the full Pi coding-agent application. Integration types remain inside
the adapters instead of defining Tesota's verification contract. Experiment guides
and evidence live under [experiments/](../experiments/README.md).

For live authentication, Tesota calls `Models.login` and handles its public
interaction. Pi owns authorization requests, polling, exchange and its default
in-memory credential store. Tesota selects the interaction, limits its lifetime
and controls what is displayed or retained. It does not implement a second OAuth
protocol or persist credentials. See the [Pi decision](decisions/002-use-pi.md).

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

The synthetic adapter validates and admits a verification request before invoking
the shared executor. Pi receives a small result projection; canonical evidence
stays with Tesota. Model output cannot grant verification authority or human
acceptance. Current experiments return `taskAcceptance: "not_evaluated"`.

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
