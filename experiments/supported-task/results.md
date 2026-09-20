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

The first follow-up request was then entered once through Tesota Shell. Discovery
ended in about four seconds before a proposal, repository operation, candidate
or authority existed. A separate controlled local fixture reproduced the cause:
the fixed Luna route issued `tesota_list` with the natural safe prefix `src/`,
while `proposalListSchema` accepted only `src` without a trailing slash. The
tool call was rejected before execution (`operations: 0`, `exposedBytes: 0`),
and the terminal was an observed error. The external request is not retried.

The corrected prefix contract accepts either a valid path or the same path with
one trailing slash, while continuing to reject absolute, empty-component and
parent-traversal forms. The controlled fixture then completed with four model
invocations, three admitted tool calls, a terminal stop and one valid task
proposal. That diagnostic establishes route/schema compatibility only. A
[second prospective follow-up](follow-up-2.md) was frozen before its distinct
external request was submitted.

The second follow-up produced a ready one-file proposal and received explicit
scope approval. The model changed `src/backends.ts` exactly once to filter empty
IDs, retain a first-seen `Set`, append only unseen IDs and stop after 512 unique
values. Its initial pre-edit scope check was observed and correctly reported no
change. The final TypeScript check began, but the cumulative 180-second task
deadline expired during the Windows dependency snapshot. The attempt retained
`status: unsettled`, four model invocations, four tool calls, one edit, an
unconfirmed settlement and no current applicable check. The source remained
unchanged, no container survived, and the candidate-owned snapshot was retained
because cleanup was not established inside the task boundary. The candidate is
not reviewable, acceptable or promotable and the task is not retried.

The snapshot is ephemeral and fully reread and hash-checked before dispatch, so
per-file durability sync was removed without weakening byte validation. A
standalone repetition still required roughly two minutes for the 1,490-file
closure on this Windows filesystem. The cumulative task deadline is therefore
now five minutes.

The [third prospective follow-up](follow-up-3.md) then produced a ready one-file
proposal and received explicit scope approval. The model changed
`src/response.ts` exactly once to require the score probability object to have
the same cardinality as the criteria and every zero-based criterion key. Its
initial no-change check and its post-edit TypeScript check both settled; the
post-edit check passed and was supplied back to the model before an observed
terminal stop. The independently required current check repeated the same
bound profile, but its compiler process exceeded the 30-second execution limit
and returned `timed_out`. The durable outcome is therefore `execution_failed`,
with six model invocations, five tool calls, one edit, one correction, observed
settlement, no decision and no application. The source remained unchanged and
no container survived. This candidate is not reviewable or promotable and the
task is not retried.

That run showed two final harness defects. A cold compiler execution can exceed
30 seconds even when the same bound profile passed earlier, so the execution
limit is now 60 seconds. Dependency hashing and snapshot copying now observe
the task cancellation signal between bounded reads and entries; a cancelled
snapshot is classified as `cancelled` rather than remaining an opaque
operation. The five-minute agent budget is unchanged.

A [fourth prospective follow-up](follow-up-4.md) was frozen before its distinct
external request was submitted.

Its fresh SysOne checkout matched baseline
`862beb481157bfd5f53893bfea612610b23b29a0`, was clean and received the exact
frozen Linux/x64 dependency closure. The standalone 60-second profile was then
approved as a preflight, but it was manually cancelled while copying and
hashing the 1,490-file dependency installation, before process dispatch. The
issued result was `cancelled`, with `process: not_started`, `container: absent`
and no diagnostics. Cancellation removed the partial candidate-owned snapshot;
no container survived and the source remained clean. The request was never
submitted to discovery or task execution, so no model invocation, proposal,
write authority, edit, review decision or application exists for this
follow-up.

This interruption confirms that cancellation now settles correctly. Later
static inspection found a more specific competing explanation for the latency:
the bounded reader allocates its 128 MiB per-file maximum plus one byte for every
dependency, even when the file is small. For 1,490 files, one complete walk
therefore requests about 186 GiB of cumulative zero-filled allocations. The
successful prepare-and-check path contains seven complete dependency reads, or
about 1.27 TiB of cumulative requested allocation. These figures are a source
trace, not simultaneous resident memory, physical I/O or a measured attribution
of elapsed time. [Node documents](https://nodejs.org/api/buffer.html#static-method-bufferallocsize-fill-encoding)
that `Buffer.alloc(size)` creates a zero-filled buffer of the requested size.

The observed multi-minute preflight remains valid, but it does not establish
that Docker or whole-installation snapshots are the primary cause. Increasing
execution or session deadlines does not correct the reader. The next live
attempt remains blocked on a bounded reader repair followed by model-free phase
measurements of preparation, source validation, copying, snapshot validation,
compiler execution, post-validation and cleanup. The initial repair retains all
existing safety passes; snapshot reuse is considered only if measurements show
that copying remains material afterward.

The controlled matrix was repeated against that exact commit on Windows x64,
Bun 1.4.2, Node 24.15.0 and Docker 29.8.0. Its sanitized record is
[windows-2026-09-19-typecheck.json](evidence/windows-2026-09-19-typecheck.json).

| Required case | Follow-up result |
| --- | --- |
| Positive | Real TypeScript 7.0.2 returned `passed`; process exited and the container was absent. |
| Compiler finding | A candidate-only type error returned one structured TS2322 diagnostic and `check_failed`; settlement was observed. |
| Missing tool | Removing Docker from executable resolution failed before profile issuance; no install or pull occurred. |
| Fatal exit | A controlled bound compiler installation exited outside the finding contract and returned `execution_failed`; settlement was observed. |
| Timeout | A controlled nonterminating compiler exceeded the then-current 30-second limit and returned `timed_out`; process exit and container absence were observed. |
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

## Bounded reader repair and refreshed profile

The reader now allocates the observed file size plus one byte, rejects a
different observed length, and checks cancellation between reads of at most
64 KiB. The per-file and installation bounds, hardlink policy, complete hash
walks and copied-snapshot validation remain in place. Nine focused regressions
cover empty and small inputs, multi-read inputs, the exact size bound,
oversized inputs, growth, truncation, hardlinks, cancellation and cleanup.
The complete `bun run check` passed on Windows from the canonical checkout
path: 391 tests, compilation, typechecking and lint. An initial invocation from
a differently cased Windows path failed 21 existing compiled-path/mock tests;
those failures did not recur from the canonical path.

Three model-free preflights used the unchanged fourth-follow-up SysOne checkout
and its existing 1,490-file dependency installation. Temporary wrappers around
the compiled functions measured wall time with `performance.now()`. They did
not change profile arguments or remove checks. Bun 1.4.2 executed the harness;
the host also had Node 24.15.0 and Docker 29.8.0. The first sample had no explicit
cache warmup; samples two and three reused source dependencies with fresh
candidates and fresh snapshots. Repository tests ran concurrently. These are
local phase observations, not an isolated benchmark or a measured speedup over
the old reader.

| Phase, seconds | First | Second | Third |
| --- | ---: | ---: | ---: |
| Preparation, including first dependency hash | 18.036 | 2.226 | 2.043 |
| Pre-dispatch source validation | 1.664 | 1.582 | 1.344 |
| Copying, including per-file rereads | 24.303 | 12.284 | 11.300 |
| Snapshot validation before dispatch | 0.959 | 0.814 | 0.782 |
| Compiler invocation and settlement | 27.376 | 24.853 | 24.284 |
| Snapshot validation after execution | 0.877 | 0.860 | 0.876 |
| Source validation after execution | 1.493 | 1.420 | 1.492 |
| Total, including snapshot setup and cleanup | 75.006 | 44.308 | 42.402 |

All three returned `passed`, with the client exited, container absent, and no
retained dependency snapshot. Copying remains material, but these complete
checks justify proceeding to the frozen task without changing the five-minute
task budget or adopting snapshot reuse. The original allocation analysis is
still a source-derived count, not measured physical memory or elapsed-time
attribution.

A fourth warm preflight, after the repository gate and task execution had
settled, measured snapshot cleanup separately: 0.231 seconds. Its total was
37.824 seconds, including 9.991 seconds of copying and 21.694 seconds of
compiler invocation and settlement. It also passed and removed its snapshot.
The shell was idle at the human decision prompt during this sample.

The [refreshed live matrix](evidence/windows-2026-09-19-reader-repair.json)
uses the uninstrumented final implementation and records its source hashes.
A temporary repository used the existing portable TypeScript 6.0.3 compiler;
controlled entrypoint substitutions exercised fatal exit, timeout and
cancellation. Passing, compiler finding, missing tool, fatal exit, timeout,
cancellation and source-drift cases returned their expected classifications.
All dispatched processes exited and their containers and dependency snapshots
were absent afterward. The Docker isolation qualification passed all controls,
including descendant settlement. The separate native Windows probe failed its
effective root-read prerequisite; it does not qualify a native provider.

These observations qualify the exercised Windows/Docker route. They do not
establish external-task acceptance, application, independent delivery review or
Milestone 1 completion.

The frozen fourth follow-up was then submitted once through the ordinary
Tesota Shell. The implementing assistant entered scope approval under the
user's instruction to proceed; this interaction is recorded separately from
the later human acceptance decision. Tesota changed only `src/backends.ts`,
adding the absent-limits guard. Execution completed in 153.016 seconds with
five model invocations, four tool calls and one edit. The first no-change
scope check failed as expected, and the post-edit and independently current
TypeScript checks passed with observed settlement. Preparing review performed
two further checks and reached the normal acceptance prompt 232.595 seconds
after execution started.

The [prospective observation](evidence/windows-2026-09-19-fourth-follow-up.json)
retains exact result and review digests. Static inspection of the diff, parsing
schema and `probeLimits` caller found the requested guard and unchanged positive
mapping. This is an assessment by the implementing assistant, not an independent
delivery review or a behavioral test. The runtime correction counter is one;
the single edit implemented the original request, so that counter does not
establish diagnostic repair. Token usage and cost remain unavailable.
The human accepted this exact candidate after seeing the guard and passing
checks. Acceptance was relayed to the waiting shell. The guarded promotion then
returned `promotion_not_applied`, with the source unchanged, no source-write
attempt and no surviving check container or dependency snapshot. The shell
returned to its ordinary prompt and exited normally on blank input. The retained
outcome reports 602.167 seconds from the approval prompt through settlement,
including operator wait and the repeated review and promotion checks.

Read-only diagnosis found the next blocker. `core.autocrlf=true` produced a
clean CRLF source worktree, while `readCandidateBaselineFiles` returns the LF
Git blob. Source identity, regular-file and hardlink checks pass. The worktree
file is 12,768 bytes; its baseline is 12,395 bytes. Replacing CRLF with LF in
memory makes the bytes exactly equal. `preparePromotionFiles` compares the raw
worktree bytes with that blob and therefore rejects the source as changed,
before creating a promotion journal. The diagnostic is reconstructed from the
read-only preconditions because the public promotion error omits its cause.

The fourth follow-up remains a failed application outcome and is not retried or
adapted. This failure required distinguishing an admitted source worktree's
exact bytes from the committed blob without weakening drift detection or
running repository-defined filters. Normalizing the external repository to fit
the current implementation would invalidate this prospective evidence.

### Source worktree binding repair (2026-09-19, Windows)

Version 2 task plans capture exact source-target hashes and modes before editing
and bind them into checks and review acceptance. Initial candidate bytes are
recorded separately. Admission permits exact committed bytes or uniform CRLF
conversion of an LF-only text blob; it does not execute repository-defined
filters. Promotion compares the source with its admitted raw bytes and mode,
then applies exactly the accepted candidate bytes without normalizing them.
Legacy version 1 plans remain inspectable and checkable but cannot acquire a
new acceptance or be promoted by reconstructing missing admission evidence.

The [controlled regression](evidence/windows-2026-09-19-source-binding.json)
used a temporary TypeScript repository with committed `text eol=crlf`
attributes, a clean CRLF worktree and an LF Git blob. It ran the actual Docker
typecheck, review, local decision and promotion paths without a model. The
unchanged candidate first failed the required-change check; the edited
candidate passed. Synthetic local acceptance then led to `applied`, with exact
accepted bytes in the source, observed process settlement, no surviving check
container and no retained dependency snapshot. Total elapsed time was 125.338
seconds; this is a local integration observation, not a benchmark.

Tests additionally cover CRLF admission with and without committed attributes,
real and line-ending-only source drift, mode drift, stale acceptance after a
binding change, and fail-closed legacy plans. This controlled result does not
count as human acceptance, a prospective external-task success, independent
delivery review or Milestone 1 completion. The fourth follow-up remains negative
and was not replayed.

Final local verification passed `bun run check`: 406 tests across 34 files,
TypeScript compilation, compiled CLI checks and lint. `git diff --check` also
passed. An intermittent cancellation test exposed a one-second polling limit
around real Git work; its startup synchronization now waits for verifier entry
explicitly, retaining the existing test deadline and cancellation assertions.

## User-requested post-repair retry

After the frozen fourth follow-up had ended, the user explicitly requested
another attempt at the same absent-limits change. A new ordinary shell proposal
and version 2 candidate were created against the unchanged source baseline;
the old proposal, decision and failed outcome were not reused or rewritten.
The [separate retry record](evidence/windows-2026-09-19-user-retry.json) retains
the new lifecycle. The candidate passed the fixed checks, the user accepted its
exact result, and guarded promotion applied only `src/backends.ts`. A raw hash
comparison confirmed the source matched the accepted candidate. The shell
returned to its useful prompt and exited normally.

Execution took 160.356 seconds; total recorded time was 1,006.150 seconds,
including human wait and repeated checks. The result used five model
invocations, four tool calls and one edit. Tokens and cost remain unavailable.
This is a known-task diagnostic success, not a replacement prospective success
or independent delivery review. The original fourth follow-up remains negative.
The [fifth follow-up](follow-up-5.md) defines the next distinct prospective case.

## Fifth prospective follow-up: HTTP byte-budget validation

The [frozen protocol](follow-up-5.md) and evaluator-only oracle were fixed
before submission. The new source checkout came from committed public history,
not from the earlier edited worktree. Its frozen dependency install disabled
scripts and omitted optional packages. The real Docker preflight passed with
observed settlement. The first candidate-creation observation reported dirty
source, but subsequent status and diff were empty and the task-start record
confirmed a clean source. No tracked file was edited to make the task fit.

The [observation](evidence/windows-2026-09-19-fifth-follow-up.json) records a
ready one-file proposal and scope approval entered under the user's instruction
to continue. The model added only a non-negative-safe-integer guard at the
start of `readBoundedText` in `src/http.ts`. Execution took 101.923 seconds,
with five model invocations, four tool calls and one edit. Initial unchanged
scope correctly failed; post-edit and independently current TypeScript checks
passed. The ordinary shell reached the exact-result acceptance prompt.

The frozen behavioral oracle failed all 12 invalid-limit cases against the
baseline and passed its six preservation cases. Against the candidate it passed
all 18 cases. The candidate file hash was confirmed unchanged at review. Plain
Node type stripping initially could not load the baseline parameter property;
the evaluator command was corrected before submission to use Node 24.15.0's
experimental type transformation. This is disclosed evaluator setup, not a
product-path change or a task retry. No full SysOne integration or release gate
was run. Tesota's complete repository gate ran concurrently, so elapsed values
are not an isolated performance comparison. That gate passed all 406 tests,
typechecking, compilation and lint; `git diff --check` also passed. Frozen
protocol, oracle and implementation hashes still matched at closeout.

The user accepted the exact guard after seeing its diff and evidence. The normal
shell recorded that decision, repeated the current checks and applied only
`src/http.ts`. Its raw SHA-256 matched the accepted candidate, and all 18 oracle
cases passed again against the applied source. The shell returned to its useful
prompt and exited normally. Total recorded time was 1,163.954 seconds, including
human wait and repeated checks; it is not execution-only latency.

This supplies the distinct prospective accepted-and-applied result missing from
the earlier attempts, without erasing their negative outcomes. The user later
reported that an anonymous external reviewer reviewed the work and found it
satisfactory, and explicitly requested recording that review without an
identity. This is an operator-reported favorable review, not an independently
inspected review artifact. No findings were reported; the exact inspected
revision and coverage of the final local changes were not confirmed.

The user subsequently confirmed that the anonymous review covered the final
local changes and requested closure. The review is therefore recorded as
operator-attested and applicable to those changes, with no reported findings.
The observation retains the implementation hashes rather than inventing a
reviewed commit. The review text, reviewer tools and identity were not supplied.
PR #135 had no formal GitHub review at inspection; its visible comments covered
earlier revisions. The later protocol's one maintainer-coordinated external
review is satisfied by the user's report and explicit coverage confirmation;
this does not manufacture a formal GitHub approval or merge authority.

## Milestone 1 qualification closure

Qualification is complete for the exercised narrow Windows/Docker route:
the refreshed live profile matrix, 406-test local gate, prospectively selected
HTTP-budget task, 18-case behavioral oracle, explicit human acceptance,
exact-byte application and return to a useful prompt are retained above.
External review applicability is operator-attested, not independently verified.
Earlier failures and the diagnostic retry remain separate observations.

The fifth protocol and oracle were hash-frozen locally before submission, not
committed before execution; the retained freeze and runtime timestamps disclose
that provenance. This is a bounded feasibility conclusion, not a representative
reliability rate, SysOne release qualification or cross-platform live claim.
Publishing the delivery candidate, passing its required Ubuntu/Windows CI and
the maintainer's merge decision remain separate delivery steps. Milestone 2
is the next product increment; semantic revision is still unsupported.
