# Supported task qualification

The frozen post-correction cases are recorded separately in the
[first](follow-up.md), [second](follow-up-2.md), [third](follow-up-3.md) and
[fourth](follow-up-4.md) and [fifth](follow-up-5.md) follow-up protocols; they do not rewrite this original
corpus.

This record freezes a small prospective evaluation of Tesota's supported
TypeScript source-task flow. Selection happened on 2026-09-19 before any task
was submitted to Tesota. No result had been observed when this protocol was
committed.

The experiment asks whether a developer can complete one worthwhile bounded
change through the ordinary shell while the exact-result, authority, failure
and application distinctions in [product qualification](../../docs/qualification.md)
remain visible. It is not a benchmark of general coding ability and will not
produce a reliability percentage.

## Frozen task corpus

The repositories and baselines are public. Each baseline already has a root
`bun.lock`, an exact numeric TypeScript development dependency, the literal
`tsc --noEmit -p tsconfig.json` typecheck script and a compatible root
`tsconfig.json`. Installing its frozen dependency closure is operator setup;
tracked repository files must not be changed to make a task admissible.

| ID | Repository and baseline | Preselected request | Class and admitted source |
| --- | --- | --- | --- |
| `duckbug-retry` | `https://github.com/duckbugio/duckbug-js.git` at `ca2c95d1e813fb58a27981b93371ff5fdf642038` | Make retry decisions consistently treat 408, 429 and 5xx except 501 as retriable; do not retry other HTTP statuses; preserve bounded exponential delay and report the number of attempts actually made. | Bug fix in `src/DuckBug/DuckBugService.ts` |
| `duckbug-event-id` | `https://github.com/duckbugio/duckbug-js.git` at `deb10f3962b1f107c3830970acdbc018ee74a8a4` | Ensure direct service sends assign a valid stable event ID when the caller omits one, so transport retries represent the same event; preserve supplied IDs and batching. | Small feature/fix in `src/DuckBug/DuckBugService.ts` |
| `sysone-linear-slashes` | `https://github.com/hraness/sysone.git` at `cd2229571fc0d161bc2e9a28a93b622ee3c6c6e3` | Replace regex-based removal of trailing slashes from the configured backend URL with a linear implementation that removes every trailing slash and preserves the remaining URL. | Bounded refactor in `src/providers.ts` |

The evaluator may use the later public commits
`deb10f3962b1f107c3830970acdbc018ee74a8a4`,
`a1c8bb4a9954e4fd3c9552e3bf4187e36523a239` and
`d728520d0379173890a730155bba2c9881d7536a` respectively as independent
behavioral references after Tesota has produced a result. Those patches and
their messages must not be supplied to the task agent. Selection from known
historical changes makes this a bounded feasibility corpus, not a random or
representative defect-rate sample.

## Frozen route and setup

Run from fresh independent clones on Windows using the current Tesota branch,
its fixed Codex/Pi route and `typescript-no-emit/v1` in the pinned,
network-disabled Linux container. Before each task:

1. record the repository URL, exact `HEAD`, clean `git status`, selection date
   and original request above;
2. install only the committed dependency closure with Bun's frozen-lockfile and
   ignore-scripts controls, then record the installed TypeScript version;
3. record Windows architecture, Bun, Node, Docker Desktop/daemon and pinned
   container image identities;
4. confirm the fixed typecheck profile can be prepared without editing tracked
   files;
5. start a new Tesota shell and enter the request verbatim; and
6. retain every refusal, failure, cancellation and incomplete attempt rather
   than substituting another task.

No credentials, raw provider response, private repository content, personal
paths or complete conversation export enters the retained report. The three
task attempts admit at most the product's existing model and tool budgets. Stop
the corpus after one attempt per task; do not adapt a request after seeing the
result.

## Task record

For every selected task, retain a sanitized row containing:

- support, refusal or failure classification and cause;
- proposal scope and whether approval occurred;
- candidate identity and changed files without a machine-specific path;
- applicable checks, their exact-result binding and remaining unknowns;
- human acceptance and local application outcome;
- independently assessed residual defects against the task statement and the
  evaluator-only public reference;
- clarification, user intervention, diagnostic repair and semantic revision
  (`unsupported` is a result, not a missing value);
- elapsed time, setup burden and review burden; and
- observed inference/tool cost, or the explicit value `unavailable`.

Report counts and causes across the three tasks. A successful typecheck does not
establish behavioral correctness, and similarity to a later patch does not by
itself establish that Tesota's result is correct.

## Real profile and failure matrix

The external tasks exercise ordinary positive, refusal and failed-check paths.
The fixed TypeScript profile also needs controlled live observations of the
operational cases below in the same declared environment. Controlled cases may
use temporary fixtures; they do not broaden product support.

| Case | Required observation |
| --- | --- |
| Positive | The unchanged eligible baseline runs the exact fixed container argv and returns a bound passing result. |
| Compiler finding | An admitted candidate-only TypeScript defect produces a real structured diagnostic and `check_failed`. |
| Missing tool | Profile preparation or runtime resolution reports `unavailable`; no install or image pull occurs. |
| Fatal exit | A controlled fixed executor exits outside the compiler-finding contract and reports `execution_failed`. |
| Timeout | The fixed invocation exceeds its deadline; process and container settlement remain explicit. |
| Cancellation | A started fixed invocation is aborted; requested cancellation and observed settlement remain distinct. |
| Surviving descendant | The existing isolation qualification runs in the same environment and reports descendant settlement; it establishes confinement behavior, not a TypeScript result. |
| Source drift | Candidate or source bytes change after the applicable evidence/review boundary; checking or promotion refuses stale input and applies nothing. |

Each observation binds the repository/fixture identity, platform and
architecture, runtime/tool versions, image digest, profile version, source
hashes, result status and process/container settlement. Synthetic regression
tests remain separate evidence and cannot replace these live rows.

## Independent review and closure

The three-review arrangement below belongs to the original corpus. The later
follow-up protocols supersede it with one maintainer-coordinated delivery PR
review selected by the operator; Tesota does not request additional reviews.
Task-result acceptance and delivery review remain separate decisions.

The delivery pull request receives three visible reviews:

1. a human maintainer review with sole acceptance and merge authority;
2. a GitHub-hosted remote-agent review; and
3. a local independent agent review against the exact pull-request head.

Record each reviewer's identity, available tools, inspected revision, findings,
abstention or failure, and the disposition of every material finding on the
pull request or tracking issue. Agent reviews are neither check evidence nor
acceptance authority.

Milestone 1 remains active if any required task record, real-profile row or
review is missing, if uncertainty is collapsed into success/failure, or if the
ordinary path requires the user to coordinate internal IDs.
