# Tesota bootstrap

A private, provisional package. It provides CLI help, invalid-argument errors,
active development checks and one shared Oxlint executor (M2.1). It does not
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

## One local check (M2.1)

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
Inline disable directives are rejected. It reads the selected source without
executing it. Input is limited to 1 MiB, captured stdout and stderr together to
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
are not admitted. Installed package version is checked; binary integrity and
candidate binding are not established by that version check.

The CI workflow declares Windows and Linux checks without provider credentials.
Its presence does not mean GitHub Actions has run. See the
[M1 evidence](docs/m1-evidence.md) for actual local results and limitations.

M2.1 supplies the shared runner only. The next bounded task is binding each
result to the exact source and profile inputs, with a test that an edit
invalidates applicability. Durable evidence and full staleness handling remain
required before M2 closes. Pi and Codex OAuth integration remain M3 work.
