# Experiments and retained evidence

These records describe bounded observations at the source, toolchain and date
recorded. They are evidence for those attempts, not current product acceptance.
The [roadmap](../docs/roadmap.md) owns current status and priority, and
[qualification](../docs/qualification.md) defines capability criteria.

| Area | Record |
| --- | --- |
| First prospective repository task and follow-ups | [Supported task](supported-task/README.md) |
| Practical external-task pilot, including failures | [Practical use](practical-use/2026-09-22-results.md) |
| Optional independent review provider | [Gentle AI](gentle/README.md) |
| Fixed static check selection | [Oxlint](oxlint/README.md) |
| Windows sandbox and container comparison | [Isolation](isolation/README.md) |
| Current live model-probe commands and older records | [Codex](codex/README.md) |
| Historical Pi compatibility and fixture exercises | [Pi](pi/README.md), [verification](codex/verification.md), [candidate correction](codex/candidate.md) |

Historical fixture adapters have been retired. Their JSON records remain at
their original paths and preserve their original schema versions and bytes.
Source hashes bind records to captured files; they do not independently prove
provider behavior or grant human acceptance. Read each record's limitations
before using it to support a claim.

New live probe records use `tesota-codex-evidence` version 9 under `codex/runs/`.
The [Codex guide](codex/README.md) explains current commands and evidence
interpretation. Full conversation exports, temporary reports and personal
account details do not belong in tracked documentation. Bootstrap and toolchain
records live in [project history](../docs/history/README.md).
