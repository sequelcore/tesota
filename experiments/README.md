# Experiments

These records preserve historical observations. They do not turn old checks into
current acceptance, authenticate their producer, or prove behavior outside the
recorded scope. [Project status](../docs/roadmap.md) owns progress interpretation;
[Codex instructions](codex/README.md) own live command behavior. The
[Pi compatibility experiment](pi/README.md) describes the synthetic boundary.
The [live verification experiment](codex/verification.md) connects the real model
to one fixed verifier action.
The [candidate correction exercise](codex/candidate.md) adds one isolated source
replacement, rechecking and a review diff.
The [Gentle AI qualification](gentle/README.md) defines the bounded review
provider experiment and records immutable review, correction and recovery
observations, including the combined correction cycle.

## Retained artifacts

| Record | Meaning |
| --- | --- |
| [Initial worker report](codex/evidence/initial-worker-report.json) | Operator-supplied report for a rejected implementation; not independent verification |
| [Browser full probe](codex/evidence/browser-probe.json) | Failed before model probing; retained v1 record lacks a specific OAuth diagnosis |
| [Browser AUTH-ONLY](codex/evidence/browser-auth.json) | Authentication unconfirmed at the local timeout; zero model invocations |
| [Device-code AUTH-ONLY](codex/evidence/device-auth.json) | Successful authentication; zero model invocations and no turn probes |
| [Device-code full probe](codex/evidence/device-probe.json) | Login succeeded; first model invocation failed; abort probe absent |
| [Saved-login probe](codex/evidence/stored-probe.json) | Stored authentication resolved; HTTP 200 and completed turn; exact-response assertion failed, abort probe absent |
| [Response diagnostic](codex/evidence/response-diagnostic.json) | Expected text matched; one additional non-text block caused rejection; abort probe absent |
| [Passing saved-login probe](codex/evidence/stored-probe-passed.json) | Exact answer plus Pi thinking accepted; normal and observed-abort probes passed |
| [Live verification probe](codex/evidence/verification-probe.json) | One admitted fixture check detected the intended violation; bounded result supplied to the second model invocation; session and local evidence save passed |
| [Denied candidate attempt](codex/evidence/candidate-denied.json) | Admission rejected requests; zero edits or checks; invocation budget stopped the session |
| [Candidate newline mismatch](codex/evidence/candidate-newline.json) | Correction and checks completed; version 2's final-newline assertion rejected the source |
| [Passing candidate correction](codex/evidence/candidate-passed.json) | One edit, two issued checks and review diff saved; previous evidence stale, final evidence applicable |
| [Codex history](codex/history.md) | Source scouting, historical checks and diagnostic findings |

Verification and synthetic Pi review closure was reported in the development conversation and
recorded in the prior README. Their implemented contracts and regression suites
remain in the repository; the full independent review transcripts are not retained here.

## Interpretation and retention

Verification evidence and live experiment evidence are separate formats. The
[verification contract](../docs/verification.md) defines issued results, applicability
and recovered provenance. The [live contract](codex/README.md) defines counters,
terminal observations, source/build identity and sanitized diagnostics.

Source/build hashes bind a live record to captured file contents. They do not
prove provider behavior independently or grant human acceptance. Record schema
versions describe the producer at the time; preserve old bytes rather than
upgrading historical records to a newer schema.

Retained JSON files were relocated without changing their bytes. Their internal
milestone identifiers and source hashes describe the original implementation.
New records use `tesota-codex-evidence` version 9 and unique filenames under
`codex/runs/`. The CLI reserves output exclusively before inference. There is no
legacy-path fallback. Keep additional evidence only for a concrete experiment with a clear
interpretation; incomplete reservations and failed attempts must remain visibly
different from successful records.

Full conversation exports, temporary reports and personal account details belong
outside tracked documentation. Retain useful decisions in their canonical pages
without making the private transcript a prerequisite for contributors.

Bootstrap provenance and toolchain validation are [project history](../docs/history/README.md),
separate from agent integration experiments.
