# M1 local acceptance evidence

Recorded 2026-09-09 on Windows 11 Pro x64, build 26200.

## Scope and provenance

Historical source: `4257ee9fce034cfe8e50dce3dbe3afb12f468094`.
This is not a verified functional baseline. The normal `tesota/bootstrap`
branch starts at that exact commit. M1 adds only a private CLI scaffold and
development checks; no agent engine, authentication, task storage, or provider
integration is implemented.

The [inventory](bootstrap-inventory.json) was saved before removal: 7 files
retained byte-for-byte, 9 selected for adaptation, 3,071 removed through exact
Git pathspecs. `CLAUDE.md` was reviewed and retained as its existing minimal
`@AGENTS.md` import. All inherited license and notice files remain unchanged.
No implementation package or dependency tree was copied from Kiln.

## Toolchain and installation

- Bun `1.4.0+34cbb9a40`; Node `24.15.0`.
- Direct development pins: TypeScript `7.0.2`, Vitest `4.1.11`, Oxlint `1.82.0`,
  `@types/node` `24.10.0`. No runtime dependencies.
- The first install downloaded registry packages using a task-owned cache.
- `trustedDependencies: []`, `install.ignoreScripts = true`, and
  `--ignore-scripts` prevented lifecycle execution. The selected direct package
  metadata required no installation scripts. Installed transitive manifests
  exposed `prepare` scripts in lightningcss and tinyexec; neither was run.
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

The first four commands were also run together through `bun --no-env-file run
check`. Tests build before execution, use five-second subprocess timeouts,
and pass only executable-discovery and OS temporary-directory environment
variables to the CLI. No provider credentials are passed to those children.

## Negative evidence

The implementation's invalid-argument exit code was changed from `2` to `0`.
`bun run test` rebuilt the CLI and exited 1: four invalid-argument cases failed
with `expected +0 to be 2`; four help cases passed. The source was restored,
and the unchanged tests then all passed. The test file SHA-256 throughout was
`69988ac35ea4bfd9c9d2d66f47ee92097b1c8f794446b5a99f44538331b1bc37`.

A temporary unused-variable probe also made `bun run lint` exit 1 with an
`eslint(no-unused-vars)` diagnostic. The probe was removed; no lint fixes were
applied. An initial mutation-log capture failed because Python used the Windows
default encoding; its `finally` block restored the source. Repeating with
explicit UTF-8 produced the recorded negative and restored results.

## Preservation and limitations

Before M1, the operator authorized saving and pushing Kiln's pending work and
documenting a development freeze. That checkpoint is
`9b604b105fbf3644328e187b862233660280b604`; the two preceding local commits remain
in its ancestry. Its documentation check passed; the saved implementation's
full test suite was not rerun or certified.

SHA-256 comparison covered all 3,091 frozen Kiln files and found no changes
during M1. A separate comparison against the pre-freeze capture covered 3,090
files excluding the explicitly edited roadmap and found no unexpected content
changes. Kiln remained clean at the frozen commit. The candidate's `.git` link
was preserved, and all seven retained attribution files matched their original
checkout hashes.

GitHub Actions and the declared Linux lane were not executed as M1 validation.
Local results establish Windows behavior only. No M1 push, merge, tag,
publication, provider call, credential change, or global installation occurred.
The baseline freeze's push is a separate authorized action.

M2's first small task is a model-independent check runner that distinguishes
check failure from execution failure and exposes the same result to a CLI.
M1 does not claim a shared verification service or an operational agent.
