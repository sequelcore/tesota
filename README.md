# Tesota bootstrap

A private, provisional M1 package. It provides CLI help, invalid-argument errors,
a compiled JavaScript entry point, and active development checks. It does not
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
All other argument combinations print a diagnostic on stderr and exit 2.

The CI workflow declares Windows and Linux checks without provider credentials.
Its presence does not mean GitHub Actions has run. See the
[M1 evidence](docs/m1-evidence.md) for actual local results and limitations.

M2's first bounded task is a model-independent check runner with typed outcomes
for success, check failure, and execution failure, consumed by a CLI. Candidate
binding, stale evidence, cancellation, and persistence follow within M2.
Pi and Codex OAuth integration remain M3 work.
