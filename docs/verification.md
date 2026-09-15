# Verification

Build first with `bun run build`, then run from the repository root:

```sh
bun --no-env-file dist/cli.js verify src/cli.ts
```

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
limits. Approval is consumed for that invocation and is never reconstructed
from output or disk state.

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
results fail closed. Candidate, configuration, lockfile, compiler installation
complete dependency installation and Docker executable are re-observed after execution; drift invalidates the
result. Issued evidence has `authority: none` and is not task acceptance.

This concrete producer is not yet part of the model task loop and creates no
generic verifier framework. Its live Docker qualification is intentionally
pending until task-sized code work exists; current tests exercise admission,
bindings, result interpretation and failure settlement with synthetic fixtures.

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

See [architecture](architecture.md) for ownership and [experiments](../experiments/README.md)
for recorded validation.
