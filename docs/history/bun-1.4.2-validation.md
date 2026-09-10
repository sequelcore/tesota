# Bun 1.4.2 compatibility evidence

Tested on Windows 11 Pro x64, build 26200, starting at
`37743ee36256db654667fb0c4ecc08147ff57823`. M1's historical results remain
recorded separately for Bun 1.4.0 at `68f62d25`.

## Selection and identity

The new-project selection rule requires the current stable patch; existing pins
change only through an explicit upgrade. This authorized test selected official
[Bun 1.4.2](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2), released
September 5, 2026. The 1.4.1 and 1.4.2 release notes were reviewed, including
runtime, installation and Node-compatibility changes. No additional M1 API or
dependency changes were required by the tested path.

The official `bun-windows-x64-baseline.zip` was downloaded into a private
temporary tool directory. Its SHA-256 matched the official release asset digest:
`78c221c2376f79731ccf4e4af0b3bb46d81fefa3296c5abee09ad8a1b21e68c6`.
The executable reported `1.4.2+744846f84`; the previous runtime was
`1.4.0+34cbb9a40`. This checks downloaded bytes against release metadata; it is
not an independent signature verification.

The parent commands used the absolute private executable. Their process-scoped
PATH contained its directory, the existing Node directory and Windows system
directories, excluding global Bun. A nested Node-to-Bun probe confirmed that
Node `24.15.0` resolved the same private Bun executable. Project scripts and
compiled CLI tests inherited this selection. No global installation or
persistent PATH was changed.

## Checks and outcomes

A fresh archive of the starting commit, with no dependencies or build output,
received `bun install --frozen-lockfile --ignore-scripts` using an initially
empty private cache. Installation passed with all dependency selections fixed:
TypeScript 7.0.2, Vitest 4.1.11, Oxlint 1.82.0 and Node types 24.10.0.
The existing empty trust list and disabled lifecycle-script policy remained.

The lockfile stayed byte-identical, SHA-256
`1e4b2bc40199c5cbaa6ed789ad18140b4b64c0d8450539a9abbfff0539a976d1`.

| Command (private Bun 1.4.2) | Fresh copy | Final pin candidate |
| --- | --- | --- |
| `install --frozen-lockfile --ignore-scripts` | Exit 0 | Exit 0 |
| `--no-env-file run check` | Build, types, 8 tests, lint passed | Build, types, 8 tests, lint passed |
| `--no-env-file dist/cli.js --help` | Exit 0, expected stdout | Exit 0, expected stdout |
| `--no-env-file dist/cli.js --invalid` | Exit 2, expected stderr | Exit 2, expected stderr |

CI already derives Bun from `packageManager`, so no workflow edit was needed.
Node and dependency selections, lockfile and M1 evidence were unchanged.
GitHub Actions and other operating systems were not executed. This is M1-path
compatibility evidence, not a general Bun compatibility or performance claim.
The prior pin remains available in the parent commit for rollback.
