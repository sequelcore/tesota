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
installation with its own fixed argv and no shell.

Before approval, the command displays exact candidate content identity,
configuration and lockfile digests, TypeScript version and a digest of the
complete mounted dependency installation,
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

The candidate and source `node_modules` mounts are read-only. The container has
no network, added capabilities or mounted host credentials, uses a read-only
root filesystem and starts from the pinned image without pulling. Output is
bounded to 256 KiB and execution to 30 seconds. Timeout and cancellation request
container removal; the result remains `unconfirmed` if Docker absence or client
settlement cannot be observed.

Dependency observation accepts at most 100,000 regular entries and 512 MiB in
total, with no symbolic links or redirected package directories. This is a
deliberately conservative whole-installation binding for the first consumer,
not a claim that every future ecosystem should use the same limit.

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

## Protected targeted Vitest profile

`vitest-targeted/v1` is a separate, repository-owned producer. It is not yet a
CLI command, task-grant check or correction-loop input. Its sole admitted
declaration is the committed `test:fast` script
`vitest run --config tests/vitest.fast.config.ts`; Tesota never executes that
string. The application selects one or more exact test files from the committed
fast-test configuration, then invokes the observed Vitest entry with its own
fixed argv, JSON reporter, fork pool, isolation and one-worker policy.
Admission models Vitest's case-insensitive substring semantics for positional
file filters and rejects a selection if those arguments would collect any
other configured test. Exact result membership remains a second, post-execution
check rather than the first point at which over-collection is detected.

The configuration parser accepts only the current declarative fast-test shape:
one `vitest/config` import, explicit test-file include list, worker limit and
test timeout. Setup files, global setup, projects, plugins, alternate runner
settings and any other configuration shape are unsupported. Candidate changes to
tests, snapshots, manifests, lockfiles, TypeScript or Vitest configuration are
rejected, so the task model cannot weaken the selected oracle.

The binding covers candidate bytes, package declaration, lockfile, configuration
and selected-test hashes, installed Vitest and Vite identities, the runner entry,
the complete mounted Linux/x64 dependency installation, Docker executable,
containment policy and exact semantic invocation. A Windows `node_modules` tree
is never treated as portable: admission requires a separately provisioned
Linux/x64 closure, including the Linux Rolldown binding used by the admitted
runner. The producer observes and binds that closure's complete content,
package identities, native target metadata and declared Vitest version. It does
not provision the closure or establish that its entire dependency graph was
derived from the candidate lockfile, so evidence labels its provenance
`operator_provisioned_unqualified`; supplying it is an application/operator
trust boundary, not a model-controlled input. The producer neither installs
dependencies nor pulls images. Without that closure, preparation returns
`linux_x64_dependency_closure_unavailable` and issues no profile.

The pinned container mounts the candidate and Linux/x64 closure as read-only
sibling trees, has no network or mounted host credentials, and provides only a
bounded `/tmp` tmpfs. The fixed invocation uses Vite's `runner` configuration
loader and disables persistent Vitest caching, so attempted writes to the
candidate or dependency installation fail instead of mutating bound inputs. Its
client and container settlement remain independent observations.

The producer distinguishes `passed`, `check_failed`, `no_tests`, `unavailable`,
`timed_out`, `cancelled` and `execution_failed`. A pass requires an exit-zero,
strictly parsed Vitest 4 JSON report whose collection exactly matches the bound
test files and whose tests all passed. Empty, malformed, truncated, oversized,
wrong-shape or contradictory output fails closed; a nonzero result never passes.
Recognized failed assertions receive a capped diagnostic projection. A pass also
requires coherent suite, test, file, exit, signal and snapshot counters; nested
suites are accepted through normalized reported file membership rather than a
suite-count/file-count equality. A selected file with zero assertions is
`no_tests`, not a pass. Bound inputs are re-observed immediately before dispatch
and after execution; this prevents known stale input from starting the process but
does not create a filesystem lock against concurrent mutation.

The positive path was exercised on September 15, 2026 through Docker Desktop's
Linux/amd64 daemon and the pinned image: a minimal committed TypeScript fixture,
an operator-provisioned Linux/x64 closure, the real Vitest 4.1.11/Vite 8.2.2
runner and one selected test produced issued `passed` evidence with confirmed
client exit and container absence. This qualifies that bounded positive path;
it does not qualify dependency provenance, every failure/cleanup path, another
platform or composition into the task lifecycle. Deterministic tests remain the
evidence for admission, result interpretation and injected settlement cases.

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

`assessApplicability(result, currentCheck)` returns `status`, `provenance` and
`comparedAt` separately from the original execution outcome. Matching observed inputs are
`applicable`; changed source, configuration, semantic arguments, limits or
installation identity are `stale`; unreadable/missing inputs and unrecognized
result objects are `unavailable`. A check failure can still be applicable.
Comparison recognizes issued completed results and structurally validated records
registered by the recovery store, preserving their different provenance. Arbitrary
copies or caller-parsed JSON are unavailable. Completed results are immutable.

Applicability describes the inputs observed during that comparison, not a
permanent flag or an atomic view across mutable files. Installed tools are
trusted and expected to remain stable during execution: their digest is an
observation of installation contents, not loaded-image attestation. Digests do
not authenticate an asserted pass. This is not whole-repository verification.

## Durable evidence and recovery

`DurableVerificationEvidenceStore` in `src/verification/evidence.ts` is the
single owner of persisted verification evidence. It writes one JSON record
containing the completed historical outcome and its exact input binding. The
record format is identified by `tesota-verification-evidence` and version `1`;
only this implemented version is read. A save accepts only an issued, completed
result, so a copied result object cannot be persisted as if it came from the
executor.

The store serializes and enforces the 512 KiB UTF-8 record bound before any
filesystem write, preserving an existing record on size rejection. It writes a
unique temporary file beside the destination and renames it into place after
the write. Callers must coordinate access to each destination; the store assumes
a single writer and supplies no locking or concurrent-operation ordering.
A process interruption before rename leaves the previous record or no record;
recovery never reads the temporary file. Failed writes or renames attempt
best-effort temporary cleanup; abrupt process termination can leave orphaned
temporary files. Replacement relies on the filesystem's rename semantics;
interruption during rename is not independently proven here. There is no fsync
protocol or power-loss durability guarantee.
Reads are size-bounded, reject malformed UTF-8 before JSON parsing, and require
the complete exact record shape. Diagnostic text is never repaired on recovery.
Missing data is `missing`; malformed, truncated, oversized or unsupported data
is `invalid`; other read failures are `unavailable`.

A valid reload returns a recovered historical result with
`structuralValidity: "valid"` and `provenance: "recovered_untrusted"`. It is
not an issued in-process result and gains no authority from its storage path.
Only the store's successful structural parse can register a recovered object;
there is no public registration function. Binding comparison ignores object-key
order while preserving exact configuration text and argument order.
`assessApplicability` can compare its binding with current source, profile and
verifier inputs, returning `applicable`, `stale` or `unavailable` while keeping
that recovered provenance visible. A recovered `passed` result remains
historically passed when current inputs make it stale. Exact `oxlint-basic/v1`
and `oxlint-static/v2` records remain structurally recoverable, but they are
stale against the current `oxlint-static/v3` profile and cannot supply current
verification. The storage API is explicit; the CLI prints the verification
result without saving it through this store.

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
