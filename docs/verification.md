# Verification

Verification evidence answers a bounded question about an exact result under
recorded conditions. It should show the claim checked, the result it describes,
its provenance and limits, and whether the result changed afterward. A passing
profile is not a universal “verified” state and does not authorize acceptance
or application. See [using Tesota](using-tesota.md) for the user-facing
workflow; this page defines the technical profiles and evidence behavior.

## Current check and review paths

The current integrations answer different questions and do not share authority.
Use the maintained section linked from each row for the complete contract.

| Integration | Purpose | Prerequisites | Command | Output | Evidence subject | Current participation and limits |
| --- | --- | --- | --- | --- | --- | --- |
| [Oxlint `oxlint-static/v3`](#oxlint-single-file-static-profile) | Run Tesota's fixed nine-rule static check against one JavaScript or TypeScript file. | Build the CLI; use the linked `tesota` command or the compiled CLI from this checkout. The repository install supplies Oxlint 1.82.0. | `tesota verify <file.ts\|file.js>` | One JSON result on stdout; exit 0 for `passed`, 1 for `check_failed`, 2 for `execution_failed`. | A byte-exact snapshot of the selected file plus the fixed profile, execution limits and observed verifier installation. | Standalone CLI path. It is not the repository TypeScript check used by the current source task, does not establish runtime behavior and is not a sandbox. |
| [LemmaScript and Dafny](#standalone-lemmascript-and-dafny-formal-check) | Prove the annotated invocation-budget predicate used by Tesota. | Repository dependencies install LemmaScript 0.6.1; Dafny must also be installed and available to LemmaScript. | `bun run formal:check` | LemmaScript generation/additions-only validation and Dafny verification output; this is not a Tesota evidence record. | `canAdmitInvocation` and its three annotated postconditions under LemmaScript's TypeScript-to-Dafny model. | Standalone contributor check. It is not part of `bun run check`, is not candidate-bound and does not establish whole-program correctness or confinement. |
| [Gentle AI](#gentle-ai-review-provider) | Collect one currently offered independent reviewer slot for an existing candidate and lineage. | Existing candidate; absolute stable Gentle AI 2.8.0 executable with synced provider assets; an existing lineage whose status offers the reviewer slot; saved Codex login for Tesota's fixed reviewer route. | `tesota task run gentle-review <candidate> <gentle-ai-executable> <lineage-id>` | JSON relay result: `submitted` or `provider_transition_required`, plus provider or closure evidence when available. | The provider-bound candidate target, lineage, authority revision and selected review lens. | Optional review provider, not an automatic step in the supported task flow. The command does not start a lineage, acknowledge a closure, accept a candidate or promote source bytes; provider approval is not proof of correctness. |

For the standalone Oxlint path, build first with `bun run build`, then run from the repository root:

```sh
bun --no-env-file dist/cli.js verify src/cli.ts
```

Each profile below owns both its check semantics and its currently qualified
execution environment. Docker-backed and native profiles are not interchangeable:
selection must satisfy the admitted policy before approval and evidence records
the environment that actually ran. There is no fallback from a protected
profile to host-native execution. The architectural rationale is in
[decision 007](decisions/007-execution-environments.md).

## Approved repository typecheck

`tesota candidate check typecheck <candidate>` is the first repository-owned
check profile. Repository ownership is deliberately declarative: the committed
package must name the exact `tsc --noEmit -p tsconfig.json` script, but Tesota
does not execute that string. It invokes the observed matching TypeScript
installation with its own fixed argv and no shell. On the supported Windows
host and Linux-container route, admission also requires
`@typescript/typescript-linux-x64` at the same exact version when the installed
TypeScript package declares that platform dependency. Portable JavaScript
releases require no platform package; a platform-specific Windows-only install
is rejected before approval.

Before approval, the command displays exact candidate content identity,
configuration and lockfile digests, TypeScript version and a digest of the
complete source dependency installation,
Docker executable identity, pinned image, isolation-policy identity and resource
limits. For the standalone command, approval is consumed for that invocation and
is never reconstructed from output or disk state. The approved
`typescript-change` task also names this exact profile in its immutable grant;
that single scope approval authorizes its bounded check invocations without
giving the model command choice.

The profile rejects candidate changes to `package.json`, `tsconfig.json` or
`bun.lock`. Its initial configuration boundary also excludes inherited configs,
project references and compiler plugins; these would introduce additional
inputs or executable policy that this profile does not yet bind.

After approval, Tesota copies the approved dependency installation into a
bounded candidate-owned snapshot, rehashes it against the approved digest and
mounts that snapshot as read-only `/workspace/node_modules`, beside the
read-only candidate mount at `/workspace/repository`. Keeping the mounts as
siblings lets Docker create both mountpoints without writing inside the
candidate while preserving TypeScript's ancestor-based module lookup.
Regular hardlinks in a Bun
installation are accepted as source inputs, but the mounted snapshot contains
only independently copied regular files. The candidate mount is also read-only.
The container has no network, added capabilities or mounted host credentials,
uses a read-only root filesystem and starts from the pinned image without
pulling. The fixed Node process receives a 384 MiB old-space ceiling inside the
512 MiB container limit. Output is bounded to 256 KiB and execution to 60 seconds. Timeout and
cancellation request container removal; the result remains `unconfirmed` if
Docker absence or client settlement cannot be observed.

Dependency observation and snapshotting accept at most 100,000 regular entries,
128 MiB per file and 512 MiB in total, with no symbolic links or redirected
package directories. A snapshot is removed only after both process exit and
container absence are observed; uncertain settlement retains it for recovery.
This is a deliberately conservative whole-installation binding for the first
consumer, not a claim that every future ecosystem should use the same limit.

The typed outcomes are `passed`, `check_failed`, `unavailable`, `timed_out`,
`cancelled` and `execution_failed`. Exit zero is a pass only with empty compiler
output. Exit one requires diagnostics. Other apparently clean or inconsistent
results fail closed. Candidate, configuration, lockfile, compiler installation,
complete dependency installation and Docker executable are re-observed immediately
before dispatch and again after execution; drift invalidates the result. These
observations do not lock mutable inputs, so a concurrent mutation can still occur
after the pre-dispatch check. Issued evidence has `authority: none` and is not
task acceptance.

This concrete producer is part of the model task loop and creates no generic
verifier framework. Its live Docker qualification is intentionally pending until
the composed source-task flow is exercised on representative work; current tests
exercise admission, bindings, result interpretation and failure settlement with
synthetic fixtures.

## Protected targeted Node test profile

`node-test-targeted/v1` is the check for the approved source-and-test task.
The grant names one existing `tests/**/*.test.ts` file and the only candidate
files allowed to differ. Tesota records the repository's declared test script
but does not execute it or any model-selected command. It runs fixed Node argv
with TypeScript type stripping and that exact test path in the pinned Docker
image. This is a focused behavioral observation, not TypeScript typechecking
or the full repository test script.

The candidate and Tesota's compiled, SHA-256-bound Node reporter are mounted
read-only. Network is disabled; host credentials and dependency installations
are not mounted. The reporter consumes Node test events and ignores test-owned
stdout, then emits one bounded machine report. A pass requires the selected
entry path, one complete cumulative summary, at least one test, all tests
passing, no skipped/TODO/cancelled tests and a clean process/container exit.
Malformed, mismatched, empty and incomplete reports do not pass. The profile
rechecks candidate, test, package declaration, reporter and Docker-client bytes
before and after invocation. It has a 30-second container limit and no
host-native fallback. A passing report is still check evidence, not human
acceptance or permission to apply the diff.

## Oxlint single-file static profile

`bun run lint` and `tesota verify` are different surfaces. `bun run lint` uses
Tesota's repository lint configuration across `src` and `tests` as a contributor
gate. `tesota verify <file.ts|file.js>` runs the fixed single-file
`oxlint-static/v3` profile described here and does not reuse the repository lint
configuration.

The CLI and tests use `runOxlint` from `src/verification/oxlint.ts`. The trusted
application configuration selects the absolute runtime and installed Oxlint
1.82.0 entry, working directory and limits. CLI arguments select one existing
JavaScript or TypeScript file, never an executable, shell command or arbitrary
flags. The fixed `oxlint-static/v3` profile checks `no-debugger`,
`no-unused-vars`, `no-constant-binary-expression`,
`no-unsafe-optional-chaining`, `oxc/missing-throw`,
`typescript/no-explicit-any`, `typescript/ban-ts-comment`,
`typescript/no-non-null-assertion` and `oxc/no-accumulating-spread`; a pass does
not establish general correctness or acceptance.

The verifier runs in a private temporary directory with an explicit JSON config,
one thread, no external plugins, nested config, type-aware execution or fixes.
Inline disable directives are rejected. It reads a byte-exact snapshot of the
selected source without executing it. Input is limited to 1 MiB, captured stdout and stderr together to
256 KiB, process runtime to 10 seconds, and termination observation to another
2 seconds. The execution timeout starts at spawn, not during input preparation.

Each invocation prints one JSON result on stdout:

| Status | CLI exit | Meaning |
| --- | --- | --- |
| `passed` | 0 | Complete report, one file, nine rules, no violations |
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

## Input binding and applicability

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
and attributed to the original logical filename. This preserves the nine
bundled, file-local rules; project configuration, external plugins and
import-aware analysis remain excluded.
Unconfirmed termination retains both source and configuration snapshots. Failures
include binding when preparation established it; absence never implies success.

Completed Oxlint results and their input bindings remain immutable. The CLI
prints the result without persisting it. Dated experimental observations are
retained under [experiments](../experiments/README.md).

## Standalone LemmaScript and Dafny formal check

`bun run formal:check` runs the package script
`lsc check --backend=dafny src/verification/invocation-admission.ts`.
The repository pins LemmaScript 0.6.1 and Node 24.15.0. LemmaScript's
[tagged 0.6.1 setup documentation](https://github.com/midspiral/LemmaScript/blob/v0.6.1/README.md#setup)
requires Dafny 4.x or later for this backend. Tesota does not install or pin a
Dafny executable, so a contributor must make a compatible Dafny installation
available to the `lsc` process. This command is deliberately separate from
`bun run check`.

The source predicate is
[`canAdmitInvocation`](../src/verification/invocation-admission.ts). Its
annotations require these three properties:

- negative `used` or non-positive `limit` implies `deny`;
- `used >= limit` implies `deny`; and
- non-negative `used`, positive `limit` and `used < limit` imply `allow`.

For the Dafny backend, LemmaScript 0.6.1 generates
[`invocation-admission.dfy.gen`](../src/verification/invocation-admission.dfy.gen),
checks that the maintained
[`invocation-admission.dfy`](../src/verification/invocation-admission.dfy)
contains only permitted proof additions relative to generated code, and invokes
Dafny verification. The current maintained Dafny file is byte-for-byte the same
as the generated file; there are no handwritten proof additions. The command's
tool output and generated files are contributor evidence only. It does not emit
a Tesota candidate-bound verification record.

The proof is bounded by the translation model. LemmaScript maps TypeScript
`number` to mathematical Dafny `int` for this source, so the proof is not a
claim about every IEEE-754 JavaScript number behavior. It also maps
`InvocationPhase` to a closed Dafny datatype containing only `inference` and
`verification`; therefore the proof does not establish the runtime fallback
branch for an invalid phase value outside that TypeScript type. Proving these
postconditions does not establish whole-program correctness, user intent,
operating-system isolation or that arbitrary task candidates receive formal
verification.

## Gentle AI review provider

Gentle AI is an optional **review provider**, not a mathematical verifier.
The operational command is documented in
[development](development.md#toolchain-and-checks):

`tesota task run gentle-review <candidate> <gentle-ai-executable> <lineage-id>`

The command requires an existing candidate and provider lineage. The executable
path must be absolute and identify the stable Gentle AI 2.8.0 binary; after a
provider upgrade, run the provider-owned `gentle-ai sync` operation before
review so its managed assets match that binary. Tesota negotiates review
capabilities protocol 2.5, checks the executable's locally calculated SHA-256
against the provider self-report, requires STATUS v7 with `compact-v2`
authority, and verifies that the offered candidate target, lineage and reviewer
slot still match before submitting a result.

When a reviewer slot is offered, Tesota materializes the provider-owned prompt,
runs tool-free Codex inference through Tesota's saved login and fixed reviewer
route, then re-reads provider status before submission. The CLI prints a JSON
relay result. `submitted` means the offered reviewer result was submitted;
`provider_transition_required` means the current provider state offers no
reviewer slot for this command. When the provider returns a closure, Tesota can
project identity-bound reviewer findings or escalation evidence for inspection.

This command is intentionally only one operation in the provider lifecycle. It
does **not** create or start a lineage, perform provider START consent, run an
offered acknowledgement, record Tesota's human accept/reject decision or
promote source bytes. A Gentle closure state of `approved` is provider review
evidence, not Tesota acceptance, application authority or proof of correctness.
The retained [Gentle experiments](../experiments/gentle/README.md) are
historical qualification evidence; they do not replace these current usage
instructions or the [roadmap](roadmap.md) as the owner of product status.

See [architecture](architecture.md) for ownership and [experiments](../experiments/README.md)
for recorded validation.
