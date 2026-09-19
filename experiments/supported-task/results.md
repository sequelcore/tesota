# Supported task qualification results

Protocol revision: `f6c269ef`

Execution date: 2026-09-19. Platform: Windows x64, Bun 1.4.2, Node
24.15.0, Docker Desktop Linux daemon 29.8.0. The pinned image
`node@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`
was already present; no image pull occurred.

## Prospective corpus

All three preselected requests were entered verbatim into a fresh Tesota Shell
against the frozen clean baseline after installing the repository's lockfile
closure with Bun 1.4.2 and scripts disabled.

| Task | Observed outcome | Acceptance and application | Burden and remaining evidence |
| --- | --- | --- | --- |
| `duckbug-retry` | Discovery ended with exit 1 before a proposal. No candidate or write authority existed. A later setup inspection also found tracked `CLAUDE.md` and `GEMINI.md` symbolic links, which the current candidate boundary refuses. | Not reached; nothing applied. | Submitted turn returned in about 0.4 seconds. Setup was not timed separately. Intervention: request entry only. Cost and token usage unavailable. Residual-defect assessment not applicable because no result existed. |
| `duckbug-event-id` | Discovery ended with exit 1 before a proposal. No candidate or write authority existed. The same tracked symbolic-link restriction applies to this repository. | Not reached; nothing applied. | Submitted turn returned in about 0.4 seconds. Setup was not timed separately. Intervention: request entry only. Cost and token usage unavailable. Residual-defect assessment not applicable. |
| `sysone-linear-slashes` | Discovery ended with exit 1 before a proposal. No candidate or write authority existed. A separate candidate checkout succeeded, but the then-current fixed profile rejected hardlinked files in the Bun dependency installation before approval. | Not reached; nothing applied. | Submitted turn returned in about 1.3 seconds. Setup was not timed separately. Intervention: request entry only. Cost and token usage unavailable. Residual-defect assessment not applicable. |

No clarification, diagnostic repair or semantic revision occurred. Semantic
revision remains unsupported. Counts for this corpus are therefore: zero
supported proposals, three discovery failures, zero accepted results and zero
applications. This is a feasibility failure, not a measured reliability rate.

## Live route diagnostic

After the three frozen task attempts failed in the same phase, the separate
bounded `live:codex` diagnostic was run once. Its sanitized version 9 record is
retained outside tracked files at the normal ignored runs location. It observed:

- stored authentication succeeded;
- one model invocation and one invocation attempt;
- HTTP 429 at the provider boundary;
- a terminal error and observed settlement;
- no text, thinking, tool execution or abort probe; and
- disposition `failed`.

The diagnostic contract does not identify the cause of an HTTP 429. These
observations do not establish quota exhaustion, entitlement failure or a
provider defect. The fixed route was not changed and no fallback was attempted.

## Execution-environment observations

The current `isolation qualify` command completed on the same machine. The
pinned Docker path passed every declared filesystem, credential, network,
descendant and cancellation control and remained the selected backend. The
Codex Windows sandbox path failed because its effective elevated sandbox did
not provide the required root read access; it is not the selected TypeScript
execution environment.

The prospective corpus used the pre-change profile and its real fixed-profile
positive row did not start: preparation rejected hardlinks in the installed
dependency tree. Reinstalling with Bun's `--backend=copyfile` still produced
hardlinks through dependency deduplication. No approval prompt or compiler
process occurred.

The follow-up implementation now accepts hardlinks only as source inputs, makes
a bounded candidate-owned regular-file snapshot after approval, verifies its
digest and mounts only that snapshot read-only. A post-change SysOne preparation
still failed closed because its installed CUDA dependencies contain individual
files larger than the profile's 128 MiB per-file bound. A separate clean Tesota
clone remained in dependency preparation for more than two minutes and was
operator-cancelled before approval. Neither observation supplies a positive
live matrix row.

| Required case | Result |
| --- | --- |
| Positive | Not established. Hardlinks are now handled through a copied snapshot; the external repository exceeded a separate per-file bound and the controlled Tesota preparation was cancelled after more than two minutes. |
| Compiler finding | Not run because no live profile could be prepared. |
| Missing tool | Not run; Docker, the pinned image and TypeScript were present. |
| Fatal exit | Not run. |
| Timeout | Not run. |
| Cancellation | Docker isolation cancellation controls passed; a TypeScript invocation was not reached. |
| Surviving descendant | Docker isolation descendant settlement passed; this establishes the isolation control only. |
| Source drift | Deterministic candidate and promotion suites cover refusal, but the required live row was not run. |

## Disposition

Milestone 1 remains active. The negative corpus is retained and must not be
rewritten as success. The frozen corpus demonstrated two independent blockers:

1. the fixed live model route returned a settled HTTP rejection before it could
   produce a proposal; and
2. the verifier's then-current dependency binding rejected the hardlinked layout
   produced by a real Bun installation.

The second blocker was addressed without weakening confinement by copying the
approved dependency tree into a bounded candidate-owned snapshot, rehashing it
and mounting only the snapshot read-only. The live matrix remains incomplete,
including a demonstrated preparation-cost concern on a 25,692-file, 231.59 MiB
installation. A later prospective run requires a newly frozen protocol revision;
these three attempts must not be retried under the original protocol. The
provider route remains an external prerequisite and must not be bypassed through
silent model fallback.

## Follow-up live qualification

On 2026-09-19, the operator replaced the exhausted account through Tesota's
documented logout/login flow. A new `live:codex` run used the fixed
`openai-codex/gpt-5.6-luna` route and passed both bounded probes: stored
authentication resolved, both requests received HTTP 200, the normal turn
returned the exact expected token, and the abort probe observed an `aborted`
terminal. Both effects had observed settlement, no tools ran and no fallback was
used. The ignored raw version 9 record remains in operator-private state with
SHA-256 `07d6d33cf34c0eec99f8489538966325a3d27267ca9a57a4e5bcc5a9f2915cef`.

Live probing then exposed a container-layout defect: Docker could not create the
nested `/workspace/node_modules` mountpoint inside the read-only candidate
mount. Commit `93266254523946fb539113d36631b2d585a71c2a` moved the dependency
snapshot outside the candidate's read-only mount and rejects a Windows-only
TypeScript 7 installation before approval. A subsequent correction limits that
platform-package requirement to TypeScript releases that declare it. Live
external preflight then showed that `/dependencies/node_modules` was outside
TypeScript's module-resolution ancestry; the corrected sibling layout is now
`/workspace/repository` and `/workspace/node_modules`, preserving dependency
lookup without nesting a mount inside the candidate.

The same frozen SysOne preflight then exposed Node's automatic heap ceiling:
under the 512 MiB container limit, TypeScript exhausted a roughly 256 MiB heap
and exited fatally. The fixed policy now sets a 384 MiB old-space ceiling while
retaining the 512 MiB container limit. Repeating the exact standalone profile
against follow-up baseline `3960a9be66ec531748b05b4e5ffb60e2d98c4a12`
returned `passed`, with the process exited, container absent and no diagnostics.
No follow-up task had been submitted to the model when this preflight completed.

The controlled matrix was repeated against that exact commit on Windows x64,
Bun 1.4.2, Node 24.15.0 and Docker 29.8.0. Its sanitized record is
[windows-2026-09-19-typecheck.json](evidence/windows-2026-09-19-typecheck.json).

| Required case | Follow-up result |
| --- | --- |
| Positive | Real TypeScript 7.0.2 returned `passed`; process exited and the container was absent. |
| Compiler finding | A candidate-only type error returned one structured TS2322 diagnostic and `check_failed`; settlement was observed. |
| Missing tool | Removing Docker from executable resolution failed before profile issuance; no install or pull occurred. |
| Fatal exit | A controlled bound compiler installation exited outside the finding contract and returned `execution_failed`; settlement was observed. |
| Timeout | A controlled nonterminating compiler exceeded 30 seconds and returned `timed_out`; process exit and container absence were observed. |
| Cancellation | The same controlled compiler was cancelled after dispatch and returned `cancelled`; process exit and container absence were observed. |
| Surviving descendant | `isolation qualify` passed every Docker control on the same platform and image. |
| Source drift | Candidate bytes changed after profile preparation; dispatch did not start and the result was `input_drift`. |

This completed the controlled live TypeScript-profile matrix for the then-current
Windows/Docker command. It does not repair or replace the original negative
corpus. The later mount, exit-code and fixed-heap corrections change the exact
command and policy binding, so the controlled matrix must be refreshed against
the final implementation. Milestone 1 also remains active until the newly
frozen prospective external task supplies successful end-to-end usefulness
evidence through the ordinary conversation, review and application path.
