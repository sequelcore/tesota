# Cross-repository practical-use sample: frozen protocol

Selected 2026-09-23 before submitting any of these requests to Tesota. This is
a small, purposive sample of different tasks and repository configurations, not
a random benchmark or a reliability estimate. Use the ordinary compiled Tesota
shell and the current fixed Codex route. One request and one attempt per case;
retain refusal, failure, rejection and incomplete outcomes. Do not adapt a
request or repo configuration to obtain success.

## Frozen tasks and criteria

| ID and baseline | Verbatim request | Independent acceptance criteria |
| --- | --- | --- |
| `tgrep-glob`, `microsoft/tgrep@56f8c62a2255d794bcaafca5f6a05dcc2d793ad0` | "In this repository, can a positive `--glob` include an otherwise ignored file when tgrep uses an index or running server? How does `--no-index` change that, and does `--hidden` disable ignore rules? Cite the relevant repository evidence." | Answer says indexed/server glob filters cannot reinclude ignored files; a filesystem scan with `--no-index` retains positive glob overrides; `--hidden` exposes hidden entries but does not disable ignore rules. Cite current repo docs or source. No mutation. |
| `sysone-memory`, `hraness/sys1@862beb481157bfd5f53893bfea612610b23b29a0` | "Harden `platformRecommendation` in `src/defaults.ts`: when `memoryBytes` is explicitly supplied, reject negative, fractional, NaN, infinite, or unsafe-integer values with `RangeError` before choosing a tier. Keep zero valid and preserve the existing threshold, explicit-tier override, platform metadata, and default system-memory behavior. Change only this source file." | Independent oracle rejects each listed invalid explicit value, including with an explicit tier and unsupported platform; zero selects compact, threshold boundaries and explicit override remain unchanged. A passing contained no-emit typecheck is required but does not establish this behavior. Accept and apply only after reviewing exact bytes and oracle. |
| `utils-title-case`, `brmorillo/utils@1ff342b98e1af3f6959af465c3e06afd90f26229` | "Make `StringUtils.toTitleCase` in `src/services/string.service.ts` treat tabs and newlines as word separators while preserving the input whitespace and the existing behavior for ordinary spaces. Change only this source file." | Independent oracle expects `hello\tWORLD\nagain` to become `Hello\tWorld\nAgain`, preserves runs of spaces, and keeps the current `hello world` result. If the repository's actual configuration is unsupported by Tesota's fixed profile, record that refusal without changing it. |

The SysOne task is a bounded bug fix; the utils task is a small feature. The
tgrep task tests the read-only conversation. This corpus does not cover a new
source-and-test repository or a bounded refactor; those remain qualification
gaps even if every attempt succeeds.

## Execution and accounting

Use clean independent clones at the exact commits. For the TypeScript task,
prepare only its committed lockfile dependency closure for Linux/x64 with Bun
and scripts disabled when the repository supports the fixed Tesota profile.
Docker Desktop's Linux daemon and the pinned image must already be available;
no task may install dependencies or pull an image. Record setup time separately
from each Tesota request. Record wall time to answer or review, active operator
time entering the request and reviewing, check claims, unknowns, model/tool
counts, diagnostic repair, semantic revision, decision, application, source
status, residual defects and observed or unavailable cost. Do not estimate
monetary cost from operation counts.

Approval is limited to the exact proposed task scope. Human acceptance follows
inspection of the exact result and independent oracle; a check pass does not
imply acceptance. The user has authorized acceptance of a correct live-test
result. Do not promote an unexpected path, weaker check or defective result.
