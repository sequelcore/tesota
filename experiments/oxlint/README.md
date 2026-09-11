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
