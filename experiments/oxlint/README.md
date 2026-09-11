# Oxlint rule qualification

This record supports an internal profile decision. It is not an upstream
benchmark, an “anti-slop” claim or evidence that the selected rules establish
semantic correctness.

## Evaluated inputs

- Reference: local Kiln `dev` commit
  `9b604b105fbf3644328e187b862233660280b604`, file
  `packages/runtime/src/verification/oxlint/oxlint-analyzer.ts`.
- Consumer: Tesota's pinned Oxlint 1.82.0 single-file verifier.
- Corpus: the 53 TypeScript files under Tesota `src` and `tests` present during
  the 2026-09-11 evaluation.
- Probes: one deliberate defect and a corresponding valid control for each rule
  selected for adoption.

The reference file declared 105 rules. A categories-off scan that denied all of
them produced 159 diagnostics in the current corpus:

| Rule | Diagnostics |
| --- | ---: |
| `eslint(max-statements)` | 116 |
| `unicorn(max-nested-calls)` | 19 |
| `eslint(max-lines-per-function)` | 9 |
| `eslint(max-params)` | 8 |
| `eslint(max-lines)` | 6 |
| `eslint(max-depth)` | 1 |

The other 99 rules produced no current-corpus diagnostics. The aggregate scan
used Oxlint's CLI defaults for option-bearing structural rules rather than
Kiln's exact numeric options. That is sufficient to demonstrate unacceptable
noise for wholesale adoption, but not to compare individual structural
thresholds or repositories.

## Adopted rules

The final Tesota configuration enables these five additions alongside its two
existing rules:

| Rule | Defect detected | Valid control |
| --- | --- | --- |
| `no-constant-binary-expression` | Constant left operand makes a branch unreachable | Nonconstant expressions pass |
| `no-unsafe-optional-chaining` | Optional result is called without a safe call | Guarded optional call passes |
| `oxc/missing-throw` | Error constructed but not thrown | Explicit throw passes |
| `typescript/no-explicit-any` | Explicit `any` erases the boundary type | Concrete or `unknown` types pass |
| `typescript/ban-ts-comment` | Unexplained `@ts-ignore` suppresses the compiler | Described `@ts-expect-error` passes |

Each defect produced its exact expected rule code through the real verifier,
the source bytes remained unchanged, compiled CLI behavior agreed with the
library result, and the issued binding remained applicable. The combined
seven-rule configuration produces no diagnostics on the current corpus.

One observed limitation is important: the constant-expression probe
`true || value` was detected, while the algebraically equivalent
`value === "allowed" || true` was not. The rule is therefore adopted only for
the patterns Oxlint recognizes, not as a general tautology oracle.

## Decision and readiness

The five additions are adopted as `oxlint-static/v2`. Exact legacy
`oxlint-basic/v1` evidence remains recoverable as untrusted history but is stale
against v2, so historical passes do not apply to new bytes or the new profile.
Structural limits are rejected for this increment; no production refactor was
performed merely to reduce their counts.

Kiln's quality-gate sequencing was also compared with Tesota's existing
`bun run check` and model correction owners. No distinct current consumer or
missing lifecycle owner was found, so a second gate abstraction was not added.

Readiness is **internal-decision-ready**: the exact adopted configuration has
integration coverage and the repository gate passes. It is not externally
claim-ready because the corpus is one private repository, the probes are
deliberate fixtures, the measurement is one Windows/toolchain run and there was
no independent reproduction.

## Low-evidence follow-up

Tesota later inspected
[`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. Its explicit goal is an
opinionated rejection of low-evidence and low-signal patterns, not a universal
standard. Tesota used that distinction as policy inspiration but did not vendor
the plugin, add `@oxlint/plugins`, or copy rule code.

Two existing native rules supplied bounded equivalents for current needs:

| Rule | Evidence and disposition |
| --- | --- |
| `typescript/no-non-null-assertion` | Found six `!` assertions in tests and none in production. Explicit guards replaced all six; a defect fixture fails and a narrowed control passes. |
| `oxc/no-accumulating-spread` | Found no current violation. A reducer that copies its growing accumulator fails, while mutation of a fresh local accumulator passes. |

The two-rule final scan covered the same 53 `src` and `tests` files with no
diagnostics. They extend the verifier as `oxlint-static/v3`. The OAuth credential
owner was also refactored to replace three type assertions with a credential
type guard and safe error-code narrowing. The remaining branded source-identity
assertion is required by its nominal boundary and now records the invariant that
justifies it.

This follow-up remains internal-decision-ready under the same corpus and
single-run limitations. Historical v1 and v2 results remain recoverable but are
stale against v3.

## Cyclomatic-complexity pilot

Oxlint's native `complexity` rule measured the 53-file corpus before the pilot.
Its default maximum of 20 reported 11 functions; a probe at maximum 8 reported
63, demonstrating that 8 is not a usable immediate repository gate.

Two existing owners were selected because their observable behavior already had
focused tests and their conditions could be named without creating a new module:

| Function | Before | After | Structural change |
| --- | ---: | ---: | --- |
| `lifecycleStatus` | 26 | 6 | Shared secure marker reading, explicit abandonment and decision interpretation, and named work detection |
| `interpretOxlint` | 35 | 12 | Separate report-header, diagnostic-location and diagnostic-field projection |

No extracted helper exceeds complexity 11. Characterization now covers lifecycle
precedence, malformed terminal records, the recognized diagnostic projection and
rejection of changes to every admitted diagnostic field. Focused tests and the
complete repository gate preserve the existing outputs and failure behavior.

After the pilot, nine functions remain above 20. Complexity is therefore retained
as measured evaluation evidence, not added to `oxlint-static/v3` or treated as
human acceptance. A permanent repository gate still needs a bounded mechanism
that applies maximum 20 to new functions while recording existing hotspots
without disabling checks for an entire file.
