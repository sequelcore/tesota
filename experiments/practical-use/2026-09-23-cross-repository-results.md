# Cross-repository practical-use sample: observed results

This record follows the [frozen protocol](2026-09-23-cross-repository-protocol.md)
without replacing any attempt. Selection was purposive. The ordinary compiled
Tesota shell used source revision `824023c2dc1aea79415595c172a3742e3cba8941`
plus uncommitted documentation changes, saved Codex authentication, Windows x64,
Bun 1.4.2, Node 24.15.0, Docker Desktop Linux daemon 29.8.0 and the already
present pinned Node image. No task installed dependencies or pulled an image.

| Case | Result | Check, decision and application |
| --- | --- | --- |
| `tgrep-glob` | The ordinary read-only turn answered in about 17 seconds. It correctly distinguished indexed/server glob filtering from `--no-index` filesystem overrides, and said `--hidden` does not disable ignore rules. It cited `AGENTS.md`, `tgrep-cli/src/main.rs`, `tgrep-cli/src/search.rs` and `tgrep-cli/tests/indexed_hidden.rs`; those paths and relevant claims were checked independently. | Authority remained none and the clean clone stayed unchanged. The later Ctrl+C exit from the ready prompt does not undo the completed answer. No task check, review or application was applicable. |
| `sysone-memory` | The exact source-only scope, `src/defaults.ts`, was admitted with scope integrity and `typescript-no-emit/v1`. A contained typecheck passed on the final candidate. The first check reported `check_failed`; one edit produced the final result, without a diagnostic repair. The diff adds a six-line guard using `Number.isSafeInteger` and a nonnegative check before tier selection. | The [frozen oracle](2026-09-23-sysone-memory-oracle.mjs) failed on the baseline and passed on the exact candidate and applied source. The repository's five focused defaults tests also passed after application. The operator accepted; Tesota reported `promoted`, `Decision: accept`, `Application: Applied`. Only `src/defaults.ts` changed, its applied SHA-256 equaled the candidate's `c0d2b427693e7e302d23cfeecea2786d1e6ef9dbdde3fed68923db82372fc240`, and `git diff --check` passed. Repository-wide tests were not run by the admitted profile. |
| `utils-title-case` | The proposal and scope approval named only `src/services/string.service.ts`, but the candidate task ended `execution_failed` after one edit. Its `tesota_check` tool was denied at the operation boundary; no host check ran. Tesota recorded `Decision: not_reached`, `Application: Not applied`. The original clone remains clean. | A separate small evaluator showed the baseline fails the requested tab/newline behavior and the retained candidate passes it. The candidate also deleted an unrelated JSDoc line. That observation is neither a passing Tesota check nor acceptance. The repository has `type-check` rather than the profile's required literal `typecheck` script, and this clone had no `node_modules`; both are profile prerequisites. The retained attempt does not identify which prerequisite caused the tool denial. No dependency installation or altered check was used to replace this attempt. |

## Effort and limits

The clean clones took less than a second each to create. SysOne's frozen,
scripts-disabled Linux/x64 dependency installation took about 0.9 seconds and
its baseline typecheck preflight about 3.9 seconds. The tgrep task required no
dependency preparation. The utils profile did not match its repository script,
so dependencies were not installed solely to force this selected task through
the fixed profile. Docker and authentication were already available.

Tesota's retained SysOne task elapsed time was 469,180 ms, including approval,
review and application waits. It reported 6 model invocations, 5 tool calls,
1 edit and 11 host checks. The review choice was entered after about 31 seconds
at the review prompt, but the prompt continued processing for roughly two more
minutes; promotion then took about two minutes. The utility task elapsed time
was 124,912 ms with 5 model invocations, 5 tool calls, 1 edit and 0 host checks.
It never reached review. These clock observations distinguish waiting from
operator decisions; active hands-on seconds were not captured by an independent
timer and cannot be stated exactly. Both changes involved one request entry and
one scope choice; SysOne also required one reviewed acceptance. No clarification
or semantic revision was requested. Token usage and monetary cost were
unavailable, not zero.

The SysOne candidate diff SHA-256 was
`cea92cc5719fd78b90c3058a7a30b07e8328ca07c32c405aa43af4eb592d5f8e`.
The unaccepted utils candidate diff SHA-256 was
`034cd3ca45a342ef5f175590b3a196810e7e04adf70214ea85206631a3ccb5bf`.
These are exact-result references, not broader correctness claims.

## Assessment and next improvement

The selected sample has one satisfactory read-only answer, one accepted and
applied source-only fix in a second external repository, and one failed change
in a third. It adds cross-repository evidence but does not establish
representative reliability. The failed attempt shows a specific user-effort
cost: Tesota obtained approval, created an isolated candidate and spent about
two minutes before the fixed check could not run. The next bounded product
improvement is pre-approval eligibility inspection for the exact selected
repository check, with a concise reason when the repository declaration or
installed closure is unsupported. That inspection must remain non-authoritative;
admission and check execution must still revalidate current inputs. A separate
future sample should include a bounded refactor and source-and-test tasks in
another repository, and should time active operator work independently.
