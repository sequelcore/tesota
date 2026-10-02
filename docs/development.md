# Development

## Toolchain and checks

Use the Bun and Node versions in [package.json](../package.json). The other
tools the checks need, ripgrep for Pi's grep tool and Dafny for
`bun run formal:check`, are declared in [mise.toml](../mise.toml), which
`mise install` and Tesota's sandboxes install. From the
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

The build keeps TypeScript's compiler for the CLI and bundles the WSL sandbox
server with Bun's Node target into one ESM file, including its Zod dependency.
WSL starts it from the Windows drive; a single file avoids resolving and
reading the dependency tree across that filesystem for every readiness probe
and sandbox start. The compiled server is also tested from a folder with no
Tesota modules or dependencies beside it.

The package binary points to `dist/cli.js`. Build before `bun link`; later
builds refresh that linked executable, and `bun unlink` removes it. The lint
rule limits cyclomatic complexity to 20 in `src` and `tests` with no file
exceptions. Vitest collects this checkout's `tests/` only, leaving a nested
checkout's tests to its own scripts. The Git workspace suites, including the
shell's source-turn tests, run in a separate Vitest process with a 20-second
per-test limit so a timed-out filesystem operation cannot contaminate later
suites. Each of the two groups also writes a JUnit XML report to the ignored `test-reports/`
(`unit.xml` and `workspace.xml`), so a Tesota session on this repository can
approve `bun run check => test-reports/unit.xml, test-reports/workspace.xml`
and compare its failures with the base test by test. The opt-in
`TESOTA_LIVE_SANDBOX=1` suite exercises Docker Sandboxes' boundary live,
`TESOTA_LIVE_WSL=1` the WSL sandbox on Windows, or its Linux side directly
where bubblewrap runs, after `bun run build`, and
`TESOTA_LIVE_WEB=1` reads a real page and checks that a public name resolving
to this computer is refused; add `TESOTA_LIVE_WEB_SEARCH=1` to search through
the SearXNG in `~/.tesota/web.json`, or `TESOTA_LIVE_HOSTED_SEARCH=1` to search
with the searcher role's model, which must cite a page its search found.

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
| `bun run live:review` | Review on eight frozen candidates with known truth: defects found, false positives, refutation, correction, time, tokens and models. `--set=scope` runs five candidates for work beyond the request instead, scoring which extras are marked for the operator or would be sent back, and `--set=premise` runs four candidates for requests whose premise is false, scoring which changes acting on one are marked for the operator or would be sent back, and whether a case would send anything back, an obligation included, `--set=environment` runs a request a check blocks for a reason outside the change, a test that also fails on the base for a missing program, scoring whether its obligation would go back to the agent or to the operator (#224), and `--set=all` runs every set. A case no reviewer finished is recorded as not measured and the run goes on. `--depth=`, `--skip-corrections` and `--model-reviewer=`, `--model-refuter=`, `--model-validator=` (as `route:model`) vary it |
| `bun run live:prbench` | Tesota's review answering SWE-PRBench's pull requests, before and after refutation, for the benchmark's own judge and scorer. `--split=`, `--config=`, `--max=`, `--label=`, `--depth=` and the model flags vary it |
| `bun run live:agent` | The working agent with Tesota's own prompt, for issue #165: a request already fixed (the right result is no change), one partly fixed and one not fixed, each decided by a hidden test run afterwards; five requests beside a temptation to do more (a bug in the next function, old-style code, a TODO, a duplicated helper, a poor name) and a control that needs two files, each in scope only when it changes no path the case does not allow, keeps the case's code verbatim and passes a preserved-behavior test, with whether the reply reports the temptation recorded apart; four requests whose premise is false (behavior documented as intended, a function that does not exist, a bug in a vendored copy, a symptom that does not occur), each right only when no production code changed and the behavior holds as it was, with whether the reply says why recorded apart, and a control that makes the same report against a policy the code breaks; for issue #294, five requests that change a TypeScript function with LemmaScript contracts (a bug the contract rules out, a change the contract must follow, three fixes whose proofs need loop invariants) and a control without one, each proved by LemmaScript with Dafny after the turn, decided by a hidden test, and checked by fixed rules for a removed or loosened contract, an added `assume` or an added `requires`, with the agent's `prove` runs, tokens and time recorded; and fifteen questions measured in words, median and 90th percentile, with the facts each must state. It may run only `node --test`. Run it before and after a change to the working agent's prompt, and `--set=proofs` with `--proofs=off`, `guidance` and `tool` to compare the agent with neither, with the contract guidance alone, and with `prove`; the proof cases need Dafny. `--runs=`, `--set=all\|fixes\|scope\|premise\|proofs\|questions`, `--proofs=` and `--model-agent=` vary it |
| `bun run live:answer` | The answer check on 16 registered turns that changed no files: the first pass on every turn, scoring checkable turns skipped and conversation checked, and the full check on the 10 with a known verdict, scoring requests judged held that did not hold (missed) and the reverse (false alarms), and on a rightly declined false premise, scoring whether it is left to the operator, sent back or cleared, with time and tokens. `--stage=first-pass`, `--stage=review`, `--runs=` and `--model-triage=`, `--model-reviewer=`, `--model-refuter=` vary it |
| `bun run live:delegation` | The agent with and without explorers on questions about a frozen copy of this repository. `--runs=`, `--model-agent=` and `--model-explorer=` vary it |

A scope instruction in the working agent's prompt, registered with its
cases on 2026-09-30 before any run, is adopted only if, over two runs on one
agent model, the tempted cases kept in scope rise, none of them or of the fix
cases loses its resolution, the control stays resolved and in scope, and the
questions state as many facts. A baseline with every tempted case in scope
leaves nothing to show, and no instruction is adopted.

A check of the request's premise was registered with its cases on 2026-09-30,
before any run: `live:agent --set=premise` for the working agent and
`live:review --set=premise` for the review
([design](design/assurance.md#the-requests-premise)). The
baseline, recorded there, ran on `codex:gpt-6-luna` and `claude-code:haiku`;
a change is measured before and after on the same model. A change to the
working agent's prompt is adopted only if the false-premise cases left alone
rise, the control stays resolved, and neither the fix, scope nor question
results fall. A change to review is adopted only if false premises marked for
the operator rise, none is sent back, the control's planted claim is still
refuted, and `live:review`'s core and scope totals do not lose precision. A
baseline with every false premise left alone and marked leaves nothing to
show, and nothing is adopted.

Run the relevant evaluation before and after a change in this repository to
a reviewer, the refuter, origin checking, explorers, the answer check, their
prompts or a role's built-in model, and record the result with the change; a
change that lowers precision or adds cost without a gain is not adopted.
This rule governs what Tesota ships to everyone. An operator's own team,
chosen with `tesota roles`, needs no evaluation: each user may set any model
for any role, Tesota warns where a judge shares a model or lab with what it
judges and never refuses, and running the evaluations on a chosen team stays
an optional, separate activity. `live:review`'s eight candidates
were written with Tesota's prompts and every model finds their defects, so
they check Tesota's machinery, not which model or prompt reviews better; that
is SWE-PRBench's job.

**SWE-PRBench** scores
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

A rule's proof lives in its `.dfy`: the program LemmaScript generates, kept
also as `.dfy.gen`, plus any proof added by hand. When a specified function
changes, run `lsc regen --backend=dafny <file>.ts` before `lsc check`. Regen
generates the program again, keeps the proof additions, refuses a `.dfy`
whose generated lines were edited, and verifies the result. Running `check`
first rewrites the `.dfy.gen` that regen compares against, and regen then
refuses; restore the committed `.dfy.gen` with Git and run regen again. Never
delete a `.dfy` to regenerate it: that discards its proof additions.

Changes to verification rules, evidence formats, permissions or acceptance
criteria need rationale and checks at the affected boundary. A change must not
appear successful because it removed the condition that detected a failure.

## Branches

`main` is the stable default branch and `dev` the protected integration
branch. Work starts on a short-lived branch from `dev` and returns through a
pull request; integrated increments move from `dev` to `main` through a pull
request with a merge commit. A hotfix starts from `main` and is merged back
into `dev` promptly. Both branches require the Ubuntu and Windows checks, an
up-to-date pull request and resolved conversations, and forbid force pushes
and deletion.

## Documentation

Write maintained documentation in English, with identifiers from code and
plain explanations. Update the owner below rather than repeating its content
elsewhere. Public wording leads with what the person can do, then why the
evidence matters, then mechanism, and never claims more than was exercised.

| Content | Owner |
| --- | --- |
| Orientation | [README](../README.md) |
| The user workflow | [Using Tesota](guide/using-tesota.md), [authentication](guide/authentication.md), [choosing models](guide/choosing-models.md) |
| Built behavior and its rationale | [Design](design/overview.md); planned sections are labelled |
| Status and priorities | [Roadmap](roadmap.md) |
| Build, test and contribution practice | This page |
| Agent working instructions | [AGENTS.md](../AGENTS.md) |

Put the current rule in its owning design page and mark proposals explicitly.
The roadmap contains only current status and unfinished priorities. Record
evaluation results with the change that used them; Git retains the earlier
proposals and observations. Do not add protocols, transcripts or machine
evidence to the repository.

Keep credentials, conversation exports, scratch notes and session bookkeeping
outside tracked documentation, and do not use Kiln's private state namespace.
When moving or removing a document, update its links, and verify changed
claims against code.
