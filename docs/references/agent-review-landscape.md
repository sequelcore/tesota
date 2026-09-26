# Agent code review landscape (September 2026)

How current systems make model-written code review precise enough to act on:
which findings count, how false positives are removed, how deep a review
goes, and what evidence settles a finding. Researched on 2026-09-25 from the
source of cloned projects, vendor documentation and two studies. It informs
[decision 016](../decisions/016-review-precision.md) and
[decision 018](../decisions/018-verified-origin-and-review-forecast.md). Product
behavior changes quickly; recheck a claim before relying on it.

## What each system does

| System | Findings that count | False-positive control | Depth and focus | Evidence |
| --- | --- | --- | --- | --- |
| Codex review rubric (`codex-rs/prompts/templates/review/rubric.md`, commit `c98e263f`) | Only bugs "introduced in the commit (pre-existing bugs should not be flagged)", discrete and actionable, that the author would fix | A bug must not "rely on unstated assumptions"; speculation is not enough, "one must identify the other parts of the code that are provably affected"; each finding carries `confidence_score` and priority P0 to P3, plus an overall "patch is correct / incorrect" verdict | One reviewer; repository-specific guidance overrides the defaults, and rule-based findings must cite the instruction file and line range | The finding's code location, overlapping the diff |
| Codex's own review skills (`.codex/skills/code-review*`) | Every issue from every focused reviewer | Not stated | A coordinator runs one sub-agent per repository-specific skill: breaking changes, change size, model context, testing | File and line for each finding |
| Anthropic's code-review plugin (`plugins/code-review` in anthropics/claude-code, read 2026-09-25) | Compile errors, clear logic errors, and repository-rule violations quoted exactly | A separate validation pass: independent sub-agents confirm each flagged issue and unvalidated ones are removed; excludes pre-existing issues, style, linter-catchable issues and input-dependent speculation. The README describes an earlier 0 to 100 confidence score filtered at 80 | Four parallel reviewers: two for `CLAUDE.md` compliance, two for bugs and security or logic | Rule quotes for compliance findings |
| Cursor Bugbot ("Building a better Bugbot") | Bugs the author resolves; resolution rate is the product metric | Version 1 ran eight passes with randomized diff order, kept bugs found by a majority, and ran a validator model. The agentic version (fall 2025) investigates with tools and needed more aggressive prompts because it was too cautious | Agentic depth chosen by the reviewer | Resolution rate rose from 52% to over 70% between July 2025 and January 2026; "many changes, surprisingly, regressed our metrics" |
| Gentle AI RDD (`docs/architecture/organic-rdd.md`) | Severe candidate-caused findings trigger a correction | Native refutation before admission | Risk frozen at start chooses depth: low has no lenses, medium one focus lens, high the four lenses Risk, Resilience, Readability and Reliability | A read-only fix validator checks the one bounded correction on immutable trees |

## Studies

- **Refute-or-Promote** (arXiv 2604.19049): a stage-gated review where
  adversarial agents try to disprove each candidate before it advances, with
  cold-start reviewers against anchoring and cross-family review against
  correlated blind spots. About 79% of 171 candidates were killed before
  disclosure. "Ten dedicated reviewers unanimously endorsed a non-existent
  Bleichenbacher padding oracle in OpenSSL's CMS module; it was killed only by
  a single empirical test." Model agreement does not replace executable
  evidence.
- **Are LLMs Reliable Code Reviewers? Systematic Overcorrection in
  Requirement Conformance Judgement** (Jin and Chen, Automated Software
  Engineering, 2026; preprint DOI 10.21203/rs.3.rs-8993044/v1): models
  "frequently misclassify correct code implementation as non-compliant", and
  prompts "requiring explanations and proposed corrections" raise the
  misjudgment rate. The proposed remedy treats the model's fix as
  counterfactual evidence and validates original and revised code with tests.

## Patterns

1. **Only what the change introduced counts.** Codex, Anthropic and Gentle AI
   all exclude pre-existing problems from the findings that act on a change.
2. **A finding is a hypothesis until something tries to break it.** Anthropic
   validates each issue in a separate pass, Gentle AI refutes before
   admission, Bugbot voted and then validated, and Refute-or-Promote kills
   most candidates at adversarial gates.
3. **Executable evidence beats agreement.** Unanimous model review endorsed a
   non-existent bug; a test disproved it. Requirement-conformance judgments
   are biased toward "non-conformant" without such a check.
4. **Depth follows risk and repository rules.** Gentle AI chooses depth from
   frozen risk; Codex and Anthropic split review into focused reviewers, often
   defined by the repository's own rules.
5. **Measure before trusting a change.** Bugbot's measured iterations often
   regressed; the review itself needs an evaluation set.

## Attributing a finding to the change

Researched on 2026-09-25 for decision 018.

| System | How a finding is tied to the change | When that cannot be shown |
| --- | --- | --- |
| GitHub code scanning ([triaging alerts in pull requests](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/triaging-code-scanning-alerts-in-pull-requests), [changelog 2023-03-17](https://github.blog/changelog/2023-03-17-code-scanning-shows-more-accurate-and-relevant-alerts-on-pull-requests/)) | An alert appears on a pull request only when all the lines it identifies are in the diff; before March 2023 it showed every alert unique to the branch, "even if they were unrelated to the code changes" | The alert stays on the branch's full list, not in the pull request |
| SARIF 2.1.0 `baselineState` ([OASIS](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)) | `new`, `unchanged`, `updated` or `absent` against a previous run | With no baseline a viewer cannot know whether a result is new, so it should show the result by default |
| SonarQube new code ([about new code](https://docs.sonarsource.com/sonarqube-server/10.8/core-concepts/clean-as-you-code/about-new-code), [SCM integration](https://docs.sonarsource.com/sonarqube-server/9.9/analyzing-source-code/scm-integration)) | Lines added or changed since the reference branch or period, from SCM blame | Without SCM data it falls back to analysis dates |
| Claude Code Review ([docs](https://code.claude.com/docs/en/code-review)) | A separate "Pre-existing" severity, gray, for "a bug that exists in the codebase but was not introduced by this PR"; a verification step checks candidates against actual behavior | Not stated |
| Codex review rubric (above) | Only bugs introduced in the commit; the finding's line range must overlap the diff | Not flagged |
| Gentle AI RDD (`internal/reviewtransaction/snapshot.go`, `artifact_admission.go`, `compact_causality_test.go`, commit `8b52c465`) | Six dispositions: introduced, behavior-activated, worsened, pre-existing, base-only, unknown. "Native Go alone classifies candidate causality": introduced and worsened need the finding's lines inside a hunk of `git diff --unified=0 --no-renames` between base and candidate trees; behavior-activated needs a changed path and a line that exists in the candidate | An unsupported claim becomes unknown, and "unknown causality escalates" to the human; a finding with no location is unknown. A binary file or a changed path with no hunks is degraded evidence, absence of evidence rather than evidence of absence, and is never read as proof |

A probe on 2026-09-25 replayed Gentle AI's exact-line rule on the 137
findings recorded by Tesota's evaluation runs, against each case's real diff:
21 of 135 introduced claims, all confirmed and most of them the planted
authority defect, fell one line outside the change. Within a single run the
same bug was cited at line 2 and at line 3. Pi's read tool returns file text
without line numbers, so reviewers counted lines from the diff's hunk
headers. A line-exact rule over model-counted lines would have sent the most
serious planted defect to the operator instead of back to the agent.

## Forecasting a review

| System | Before the review | Basis |
| --- | --- | --- |
| Claude Code ultrareview ([docs](https://code.claude.com/docs/en/ultrareview)) | A confirmation dialog with the scope, including file and line counts for a branch, the remaining free runs and "the estimated cost"; reviews usually take 5 to 10 minutes | Paid usage credits, confirmed once per conversation; running the non-interactive subcommand is consent |
| Claude Code Review ([docs](https://code.claude.com/docs/en/code-review)) | No per-review prompt; the repository table shows "the average cost per review for each repo based on recent activity"; reviews average $15 to $25 and scale with size, complexity and how many issues need verification | Recent reviews of the same repository |
| Gentle AI RDD (`docs/review-integration.md`, commit `8b52c465`) | "A forecast is descriptive, not a route": the host relays every forecast step and horizon and runs only the next transition; a medium- or high-risk start may also return a consent choice, run only as the human selects | The transaction's frozen risk |

## Gentle AI's review host boundary

Read on 2026-09-25 from gentle-ai `internal/cli/review_transport_capability.go`
(commit `8b52c465`) and gentle-pi `lib/review-host-relay.ts` (commit
`b50b417c`). Gentle AI admits a runtime for review only through a compiled
transport per agent: Claude Code, Codex and OpenCode have their own, and Pi's
`pi_host_relay` is admitted only while the gentle-pi host declares
`gentle-pi.review-relay/v1`. That relay is narrow: for each lens it takes the
Go-issued prompt with `--materialize`, completes it once through Pi with no
tools and nothing discovered from the repository, and submits the raw text
through the exact provider-issued command. Go keeps the prompt, lenses,
admission, budgets, receipts and gates. Pi's agent identity appears in about
twenty Go source files, so admitting another host means registering a new
agent, not changing one condition. Contributions require an issue approved by
a maintainer before any pull request, pull requests of at most 400 changed
lines, and the project's AI-assisted contribution policy.

### Spike result, 2026-09-25

A private worktree of gentle-ai at `8b52c465` (branch `tesota-host`) located
every Pi-specific branch on the review path: the agent identifier, the
capability manifest, admission and capture in
`review_transport_capability.go`, host-mediated routing in
`review_provider_runtime.go`, and the orchestration contract in
`review_execution.go` and `reviewassets/contract.go`, about seven files of
small changes. The host side is the obstacle. Pi's orchestration contract
(`review-ledger-contract-pi.md`) makes the host drive a whole transaction:
inspect, a start that freezes the candidate and creates authority, a consent
prompt for medium- and high-risk candidates, a forecast, grouped lens
captures, RDD's own refuter, bounded correction and fix validation, an
acknowledgement that burns the authority, and more than fifteen stop codes
with their own continuations. Lens prompts are materialized only inside a
started transaction, so the lenses cannot be used alone. Integrating RDD
would run a second assurance loop inside Tesota's, duplicating decisions 015
and 016 rather than adding a reviewer.

## Open-source reviewers worth evaluating

- **PR-Agent** (github.com/The-PR-Agent/pr-agent): community-owned since
  April 2026, MIT-licensed, releases through v0.42.0 (August 2026). Oriented to
  pull requests on Git hosting services; whether it reviews a local tree was
  not checked.
- **Kodus** (kodus.io): self-hostable, AGPLv3, custom natural-language rules.
  Its license matters for anything beyond running it as a separate process.

## Sources

- Codex source: `codex-rs/prompts/templates/review/rubric.md` and
  `.codex/skills/code-review*` at commit `c98e263f` (2026-09-25).
- Anthropic: [code-review plugin README](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/README.md)
  and [command](https://github.com/anthropics/claude-code/blob/main/plugins/code-review/commands/code-review.md).
- Cursor: [Building a better Bugbot](https://cursor.com/blog/building-bugbot).
- Gentle AI source: `docs/architecture/organic-rdd.md` at commit `8b52c465` (2026-09-25).
- [Refute-or-Promote](https://arxiv.org/abs/2604.19049).
- [Jin and Chen, requirement conformance judgement](https://doi.org/10.1007/s10515-026-00638-5).
- [PR-Agent](https://github.com/The-PR-Agent/pr-agent); [Kodus](https://kodus.io/).
