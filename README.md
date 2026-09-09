# Tesota bootstrap

A private, provisional package. It provides CLI help, invalid-argument errors,
active development checks and one shared Oxlint executor with single-file input
binding and applicability (M2.2). It does not
execute agent tasks or connect to providers.

Historical provenance: `4257ee9fce034cfe8e50dce3dbe3afb12f468094` from Kiln.
This is a historical source reference, **not a verified functional baseline**.
The [file inventory](docs/bootstrap-inventory.json) records every inherited
file's disposition and original Git blob. No Kiln implementation package is
ported. Root LICENSE and NOTICE remain unchanged. The notices in
[licenses/legacy-kiln](licenses/legacy-kiln/) preserve historical Kiln
attribution with their original contents. They do not describe components
currently bundled by Tesota and do not replace the license information of
Tesota's actual dependencies. Their retention is not distribution-license
clearance.

## Development

Use Bun 1.4.2 (see the [bounded upgrade evidence](docs/bun-1.4.2-evidence.md)) and
Node 24.15.0. Exact tool selections are owned by package.json and bun.lock:
TypeScript 7.0.2, Vitest 4.1.11, Oxlint 1.82.0, and Node types 24.10.0.
Node runs development tools; Bun runs the compiled CLI. The private scaffold
retains inherited Apache-2.0 attribution without deciding public branding or
future distribution.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun --no-env-file dist/cli.js --help
```

Individual commands: `bun run build`, `bun run typecheck`, `bun run test`,
and `bun run lint`. Tests build first and exercise the compiled CLI in bounded
child processes with a minimal environment. Typechecking includes sources and
tests. Oxlint checks without fixes and rejects warnings. Installation scripts
are disabled explicitly; dependencies are registry packages, not Kiln links.

No arguments, `help`, `--help`, or `-h` print help on stdout and exit 0.
`verify <file.ts|file.js>` runs the check below. Other argument combinations
print a diagnostic on stderr and exit 2.

## One local check (M2.2)

```sh
bun --no-env-file dist/cli.js verify src/cli.ts
```

The CLI and tests use `runOxlint` from `src/verification/oxlint.ts`. The trusted
application configuration selects the absolute runtime and installed Oxlint
1.82.0 entry, working directory and limits. CLI arguments select one existing
JavaScript or TypeScript file, never an executable, shell command or arbitrary
flags. The fixed `oxlint-basic/v1` profile checks only `no-debugger` and
`no-unused-vars`; a pass does not establish general correctness or acceptance.

The verifier runs in a private temporary directory with an explicit JSON config,
one thread, no external plugins, nested config, type-aware execution or fixes.
Inline disable directives are rejected. It reads a byte-exact snapshot of the
selected source without executing it. Input is limited to 1 MiB, captured stdout and stderr together to
256 KiB, process runtime to 10 seconds, and termination observation to another
2 seconds. The execution timeout starts at spawn, not during input preparation.

Each invocation prints one JSON result on stdout:

| Status | CLI exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Complete report, one file, two rules, no violations |
| `check_failed` | 1 | Complete report with recognized lint violations |
| `execution_failed` | 2 | Input/install/spawn failure, unsupported output, timeout or incomplete execution |

[Oxlint's pinned result contract](https://github.com/oxc-project/oxc/blob/apps_v1.82.0/apps/oxlint/src/result.rs)
uses failure status for both diagnostics and operational errors. The executor
therefore requires coherent exit status and
[JSON report fields](https://oxc.rs/docs/guide/usage/linter/output-formats.html),
including file/rule/thread counts and recognized diagnostic locations. Unknown
rules, parse errors, missing output, skipped files and inconsistent results are
execution failures, not successful checks. The projection deliberately accepts
only the fields needed from that producer-owned contract; it adds no schema
library or generic verifier abstraction.

`process` distinguishes `not_started`, `exited` and `unconfirmed`. A termination
request alone never produces `exited`. An unconfirmed process includes its PID
and retains its temporary directory for operator reconciliation. This closed
native-rule profile runs one process; it is not a sandbox or a general process-tree
executor. Arbitrary subprocesses, external plugins and untrusted installations
are not admitted.

### Input binding and applicability

Every completed result includes `binding`:

- `source`: the original absolute logical filename and SHA-256 of the captured
  bytes, including BOM and line endings. No Git revision substitutes for bytes.
- `check`: the fixed profile label, exact JSON configuration text, semantic
  argument vector and execution limits. The entry placeholder is resolved from
  `verifier.entry`; random temporary paths are not part of identity. Configuration
  contents are compared even when the profile label is unchanged. Execution
  continues to admit only the existing fixed configuration.
- `verifier`: the observed installed package version, selected runtime executable
  path and SHA-256, entry path, and an installation content digest covering Oxlint
  and its resolvable installed native binding packages. `packageVersion` is read
  from installed metadata, not asserted to be a runtime self-reported version.

The executor reads at most 1 MiB plus one overflow byte, then hashes and writes
the same captured buffer to a private temporary file. It preserves the original
basename and extension, writes the recorded configuration, and directs Oxlint
only to those snapshot inputs. Diagnostics are validated against the snapshot
and attributed to the original logical filename. This preserves the two native,
file-local rules; project configuration and import-aware analysis remain excluded.
Unconfirmed termination retains both source and configuration snapshots. Failures
include binding when preparation established it; absence never implies success.

`assessApplicability(result, currentCheck)` returns `status` and `comparedAt`
separately from the original execution outcome. Matching observed inputs are
`applicable`; changed source, configuration, semantic arguments, limits or
installation identity are `stale`; unreadable/missing inputs and results not
issued by this executor instance are `unavailable`. A check failure can still
be applicable. The comparison accepts only issued completed result objects,
not copied or deserialized JSON. Completed results are immutable.

Applicability describes the inputs observed during that comparison, not a
permanent flag or an atomic view across mutable files. Installed tools are
trusted and expected to remain stable during execution: their digest is an
observation of installation contents, not loaded-image attestation. Digests do
not authenticate an asserted pass. There is no persisted evidence or recovery
protocol yet, and this is not whole-repository verification.

Behavior tests exercise real Oxlint and the compiled CLI, including exact-byte
binding, same-filename edits, same-label configuration changes and unavailable
inputs. A deterministic process-start barrier changes the original after snapshot
creation; the real verifier must still report the captured violation. Bypassing
the snapshot was tested as a controlled defect: that test failed on an incorrect
`passed` outcome, then passed after restoring snapshot execution. Existing output,
timeout and simulated unconfirmed-settlement regression tests remain in place.

The CI workflow declares Windows and Linux checks without provider credentials.
Its presence does not mean GitHub Actions has run. See the
[M1 evidence](docs/m1-evidence.md) for actual local results and limitations.

M2.2 supplies file-local binding and in-process applicability only. The next
bounded task is durable evidence storage and recovery, preserving outcome and
binding together while distinguishing recovered data from trusted evidence.
M2 is not complete. Pi and Codex OAuth integration remain M3 work.
The formatter/import-organization decision remains open; no tooling is added.
