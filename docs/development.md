# Development

## Toolchain and checks

Use the Bun and Node versions in [package.json](../package.json). From the
repository root, install with `bun install --frozen-lockfile --ignore-scripts`.
Dependencies come from registry packages; lifecycle scripts are disabled.

| Command | Purpose |
| --- | --- |
| `bun run build` | Compile the CLI to `dist/` |
| `bun run typecheck` | Check source and test types |
| `bun run test:fast` | Run deterministic tests that launch no external process |
| `bun run test` | Build and run all test groups, including process-backed suites |
| `bun run lint` | Lint source and tests without fixes; reject warnings |
| `bun run check` | Run the complete repository gate |
| `bun run formal:check` | Prove the LemmaScript rules in `src/verification/`; requires Dafny |

`bun run check` does not invoke Dafny or a live model. Tests exercise real Git
workspaces, check processes, Oxlint and compiled CLI processes. Use `test:fast`
for quick feedback on pure code, then the affected process-backed suite. Run
`bun run check`, `bun run formal:check` when a proved rule changed, and
`git diff --check` before completing a change. Report what actually ran;
passing checks, live observations and human acceptance are different claims.

The package binary points to `dist/cli.js`. Build before `bun link`; later
builds refresh that linked executable, and `bun unlink` removes it. The lint
rule limits cyclomatic complexity to 20 in `src` and `tests` with no file
exceptions. The Git workspace suites run in a separate Vitest process so a
timed-out filesystem operation cannot contaminate later suites. Each of the
two groups also writes a JUnit XML report to the ignored `test-reports/`
(`unit.xml` and `workspace.xml`), so a Tesota session on this repository can
approve `bun run check => test-reports/unit.xml, test-reports/workspace.xml`
and compare its failures with the base test by test. The opt-in
`TESOTA_LIVE_SANDBOX=1` suite exercises Docker Sandboxes' boundary live,
`TESOTA_LIVE_MXC=1` exercises the native Windows sandbox on Windows 11 24H2 or
later, and
`TESOTA_LIVE_WEB=1` reads a real page and checks that a public name resolving
to this computer is refused; add `TESOTA_LIVE_WEB_SEARCH=1` to search through
the SearXNG in `~/.tesota/web.json`.

A change to an engine adapter or to the model-session contract passes
`tests/model-session-contract.test.ts`, which holds every engine to the same
clauses, and then the opt-in live suite, `TESOTA_LIVE_MODELS=1` with
`TESOTA_LIVE_MODEL_CHOICES` naming the `route:model` choices (default
`claude-code:haiku,codex:gpt-6-luna`); it uses the operator's sign-ins and a
little model usage. A new engine joins the shared suite with a harness before
any role uses it.

## Evaluations

Live evaluations use the saved login and write one JSON record under the
ignored `live-runs/` directory.

| Command | Measures |
| --- | --- |
| `bun run live:review` | Review on eight frozen candidates with known truth: defects found, false positives, refutation, correction, time, tokens and models. `--set=scope` runs five candidates for work beyond the request instead, scoring which extras are marked for the operator or would be sent back, and `--set=all` runs both. `--depth=`, `--skip-corrections` and `--model-reviewer=`, `--model-refuter=`, `--model-validator=` (as `route:model`) vary it |
| `bun run live:prbench` | Tesota's review answering SWE-PRBench's pull requests, before and after refutation, for the benchmark's own judge and scorer. `--split=`, `--config=`, `--max=`, `--label=`, `--depth=` and the model flags vary it |
| `bun run live:delegation` | The agent with and without explorers on questions about a frozen copy of this repository. `--runs=`, `--model-agent=` and `--model-explorer=` vary it |

Run the relevant evaluation before and after a change to a reviewer, the
refuter, origin checking, explorers, their prompts or a role's model, and
record the result in [findings](findings.md); a change that lowers precision
or adds cost without a gain is not adopted. `live:review`'s eight candidates
were written with Tesota's prompts and every model finds their defects, so
they check Tesota's machinery, not which model or prompt reviews better; that
is SWE-PRBench's job.

**SWE-PRBench** ([research](research/evaluation-landscape.md)) scores
Tesota's review against human reviewers' comments on 100 real pull requests
with the benchmark's own code, pinned at pipeline v0.4.1 (commit `379f0bf`).
Set it up once under the ignored `live-runs/swe-prbench/`:

```
git clone https://github.com/FoundryHQ-AI/swe-prbench.git live-runs/swe-prbench/harness
git -C live-runs/swe-prbench/harness checkout 379f0bf
python -m venv live-runs/swe-prbench/.venv
live-runs/swe-prbench/.venv/Scripts/python -m pip install -r live-runs/swe-prbench/harness/requirements.txt huggingface_hub
live-runs/swe-prbench/.venv/Scripts/hf download foundry-ai/swe-prbench --repo-type dataset --local-dir live-runs/swe-prbench/data
```

Put the judge's `OPENAI_API_KEY=` line in `live-runs/swe-prbench/harness/.env`,
never in the repository; the official judge, GPT-5.2, is billed per token to
that key. Then answer and score:

```
bun run live:prbench --label=astra-sol
live-runs/swe-prbench/.venv/Scripts/python evaluations/swe-prbench/score.py --label=astra-sol
live-runs/swe-prbench/.venv/Scripts/python evaluations/swe-prbench/score.py --label=astra-sol --response=unrefuted
```

Tesota's reviewer receives the official context and an empty checkout, as the
benchmark's agents do, so its scores compare with the published ones; scores
from another judge or split do not.

## Adding a capability

A capability is added for a real consumer, and one that claims to improve
results is measured against the simplest alternative before it becomes a
default. Prefer an existing owner, keep one owner per behavior, and add
modules only for implemented consumers. There are no external consumers of
Tesota's internal contracts: obsolete code and documentation are removed, not
kept behind aliases or compatibility paths. Pure decision rules that can be
stated precisely, such as permissions, budgets and finding origins, carry
LemmaScript specifications and are proved by `bun run formal:check`.

Changes to verification rules, evidence formats, permissions or acceptance
criteria need rationale and checks at the affected boundary. A change must not
appear successful because it removed the condition that detected a failure.

## Reusing Kiln

Kiln is a reference, not a base. Study its regression oracles and failure
cases first, then its invariants; reuse a code fragment only when a matched
comparison shows it costs less than a Tesota-native version, and a whole
module only with an independently buildable boundary and a current Tesota
consumer. Reused code records its source commit and path, adaptations,
attribution and license obligations, and gets its own Tesota test. Kiln's
roadmap and private state are not Tesota's. See the
[Kiln reference](research/kiln.md).

## Branches

`main` is the stable default branch and `dev` the protected integration
branch. Work starts on a short-lived branch from `dev` and returns through a
pull request; integrated increments move from `dev` to `main` through a pull
request with a merge commit. A hotfix starts from `main` and is merged back
into `dev` promptly. Both branches require the Ubuntu and Windows checks, an
up-to-date pull request and resolved conversations, and forbid force pushes
and deletion. The protected tag `kiln-legacy-2026-09` holds Kiln's final
development state; historical Kiln inspection uses it, never `dev`.

## Documentation

Write maintained documentation in English, with identifiers from code and
plain explanations. Update the owner below rather than repeating its content
elsewhere. Public wording leads with what the person can do, then why the
evidence matters, then mechanism, and never claims more than was exercised.

| Content | Owner |
| --- | --- |
| Orientation | [README](../README.md) |
| The user workflow | [Using Tesota](guide/using-tesota.md), [authentication](guide/authentication.md), [choosing models](guide/choosing-models.md) |
| Current design and its rationale | [Design](design/overview.md) |
| Consequential decisions, in order | [Decisions](decisions.md) |
| Status and priorities | [Roadmap](roadmap.md) |
| What experiments and evaluations established | [Findings](findings.md) |
| Dated research that informed decisions | [Research](research/) |
| Build, test and contribution practice | This page |
| Agent working instructions | [AGENTS.md](../AGENTS.md) |

A consequential decision gets an entry in the decision log and its substance
in the design document it changes; design documents describe what is built,
and mark what is planned. Record a live observation as a short entry in
findings: what was tried, the outcome and the lesson. Research pages are dated
evidence and are not kept current; do not add protocols, transcripts or
machine evidence to the repository.

Keep credentials, conversation exports, scratch notes and session bookkeeping
outside tracked documentation, and do not use Kiln's private state namespace.
When moving or removing a document, update its links, and verify changed
claims against code.
