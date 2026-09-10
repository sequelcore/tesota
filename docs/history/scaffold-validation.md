# M1 local acceptance evidence

Historical results recorded 2026-09-09 on Windows 11 Pro x64, build 26200.
The completed M1 candidate is `68f62d256453c12b5c668e3b5fafd67458705663`.
Later documentation and attribution cleanup does not change that identity or
constitute a rerun of these results.

## Scope and provenance

Historical source: `4257ee9fce034cfe8e50dce3dbe3afb12f468094`.
This is not a verified functional baseline. The normal `tesota/bootstrap`
branch starts at that exact commit. M1 adds only a private CLI scaffold and
development checks; no agent engine, authentication, task storage, or provider
integration is implemented.

The immutable [inventory](bootstrap-inventory.json) records the original
bootstrap operation. No implementation package or dependency tree was copied
from Kiln.

## Toolchain and installation

- Bun `1.4.0+34cbb9a40`; Node `24.15.0`.
- Direct development pins: TypeScript `7.0.2`, Vitest `4.1.11`, Oxlint `1.82.0`,
  `@types/node` `24.10.0`. No runtime dependencies.
- Registry installation used `--ignore-scripts`, with
  `trustedDependencies: []` and `install.ignoreScripts = true`; lifecycle
  scripts were not run.
- A separate temporary copy received source/configuration files and the new
  lockfile, with neither `node_modules` nor `dist`. Installation used another
  initially empty cache and `--frozen-lockfile --ignore-scripts`.
- Both installs completed. The frozen install preserved the lockfile SHA-256:
  `1e4b2bc40199c5cbaa6ed789ad18140b4b64c0d8450539a9abbfff0539a976d1`.

## Executed checks

| Command | Candidate | Temporary reproduction |
| --- | --- | --- |
| `bun run build` | Exit 0 | Exit 0 |
| `bun run typecheck` | Exit 0, sources and tests | Exit 0 |
| `bun run test` | 8 passed; compiled CLI subprocesses | 8 passed |
| `bun run lint` | Exit 0, no fixes | Exit 0 |
| `bun --no-env-file dist/cli.js --help` | Exit 0; expected stdout | Exit 0 |
| `bun --no-env-file dist/cli.js --invalid` | Exit 2; expected stderr | Covered by tests |

The first four commands also passed together through
`bun --no-env-file run check`. Tests exercised the compiled CLI using bounded
subprocesses with a minimal environment and no provider credentials.

## Negative evidence

The implementation's invalid-argument exit code was changed from `2` to `0`.
`bun run test` rebuilt the CLI and exited 1: four invalid-argument cases failed
with `expected +0 to be 2`; four help cases passed. The source was restored,
and the unchanged tests then all passed. The test file SHA-256 throughout was
`69988ac35ea4bfd9c9d2d66f47ee92097b1c8f794446b5a99f44538331b1bc37`.

A temporary unused-variable probe also made `bun run lint` exit 1 with an
`eslint(no-unused-vars)` diagnostic. The probe was removed; no lint fixes were
applied.

## Limitations

GitHub Actions and the declared Linux lane were not executed as M1 validation.
Local results establish Windows behavior only; the CLI was not validated as a
Node application. Kiln's frozen implementation suite was not rerun or certified.
No provider integration was tested. M1 does not establish a shared verification
service, an operational agent, or distribution readiness.
