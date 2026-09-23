# Candidate correction

This is a retained record of a retired experiment. The `live:candidate` command
and its fixture-based adapter are no longer available.

This Windows experiment exercised a real model correcting one isolated source
file. It builds on the [verification-tool experiment](verification.md), using the
same Pi adapter, stored authentication and bounded Oxlint verifier.

Historical invocation (no longer available):

```sh
bun run build
bun run live:candidate
```

The entry point accepted only `--stored`; it could not select arbitrary files or
start login. `bun --no-env-file dist/live-candidate.js --help` was offline.

## Task and admission

Each run creates a fresh directory under ignored `experiments/codex/runs/`,
containing a one-file candidate. The initial source exports `value = 1` and has
a `debugger` statement. The model receives those fixed, non-sensitive bytes and
their SHA-256. Its task is to remove the debugger while preserving the export.
The source checkout is not edited. This is a correction exercise, not a full
candidate checkout or self-development cycle.

The required sequence is:

1. Request `tesota_verify` for the logical name `candidate.ts`; observe the real
   verifier's `check_failed` result. The tool schema fixes that exact logical name.
2. Request `tesota_edit_candidate` with the current SHA-256 and replacement text.
3. Request verification again; obtain an issued `passed` result for the new bytes.
4. Finish with `TESOTA_CANDIDATE_OK` after both check results have been supplied
   to model continuations.

The candidate owner permits one replacement, only after the initial check has
failed. It validates the expected hash and a UTF-8 size limit of 8 KiB, rejects
invalid Unicode and NUL, and grants no path argument. Exact tool arguments are
checked at execution. Concurrent operations, edits after closure, symbolic links,
multiple hard links, and unexpected on-disk changes are rejected. Writes use an
exclusively created sibling file and rename; an existing reservation is preserved.

The candidate is never imported or executed. Arbitrary source text within the
edit bound may be proposed, but success requires the exact preserved export with
only the debugger line removed; the final LF is optional. A lint-clean empty file therefore fails the task
assertion. This fixed oracle is deliberately narrower than general code correctness.

The session admits four model invocations, three tool attempts, two verifier
executions and one edit. Requests beyond those counts cannot produce a passing
exercise. Retries are disabled. The session deadline is 90 seconds with two more
seconds for abort settlement; authentication has its existing 180-second bound.
The process watchdog is 285 seconds. Source-size admission is not a provider
output-token limit. See the [verifier contract](../../docs/verification.md) for
its separate process limits and cancellation limitations.

## Review and evidence

Success requires the first issued result to become `stale`, the final issued
result to remain `applicable`, the task-specific source assertion, normal Pi
completion, and successful saves of both checks and the diff. Check status,
current applicability and human acceptance remain separate.

The original run directory retains:

- `before.ts` and `candidate/candidate.ts`: original and final source.
- `candidate.diff`: Git's bounded, local `--no-index` diff, with external diff
  commands and text conversion disabled.
- `check-1.json` and `check-2.json`: issued evidence saved by the existing durable
  store, when completed checks exist. These contain local paths.
- `probe.json`: `tesota-candidate-probe` version 3, containing implementation
  hashes, counts, event names, source hashes, check outcomes and applicability.

Version 2 makes the admitted verification input a schema literal and adds a
boolean diagnosis for denied input names. Version 1 records remain unchanged.
Version 3 makes the final LF optional in the task assertion and records
`candidateSatisfiesTask`; input bindings still identify exact bytes.

The probe excludes raw model text, arguments and credentials. The source and diff
are intentionally local review artifacts and must be treated as untrusted code.
Failed and incomplete runs remain visible; a watchdog exit may leave an empty
reservation. There is no automatic resume, acceptance, commit or promotion.

This is a trusted, single-writer local workspace. Path and identity observations
are not an operating-system sandbox or protection against a concurrent hostile
process using the same account. There is no power-loss durability guarantee.
The running verifier retains its own timeout: requesting Pi cancellation does
not prove that every subprocess or remote request stopped.
