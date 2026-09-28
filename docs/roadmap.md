# Roadmap

This page owns product status and priority. The [design](design/overview.md)
describes how each built capability works, and the [decisions](decisions.md)
record why.

## Status

Tesota is pre-release. A terminal shell runs a Pi coding agent in a separate
workspace per session and names each session after its work. Commands run
without asking in the native sandbox on Windows 11 24H2 and later or in a
Docker Sandboxes microVM, and with the operator's approval on the host
otherwise. Each result is checked by the operator's commands, Oxlint and
LemmaScript on the exact tree, reviewed by read-only reviewers whose findings
face a refuter and an origin check, and corrected by the agent at most twice
before the operator applies, rejects or keeps working; the answer check's
first pass, on turns that change no files, can use TypeSafe's Jev with the
operator's own key. Each role can use its own model, through the operator's
ChatGPT plan, an Anthropic API key, the operator's own Claude Code,
OpenRouter or OpenCode, and the agent can ask read-only explorers and consult
an advisor, both off by default.

The complete loop has run on throwaway and evaluation repositories; daily use
on a real project has not started.

## Built

| Capability | Built | Design |
| --- | --- | --- |
| Workspaces with uncommitted changes, updates from the source, guarded application, pruning | 2026-09-25 | [Workspace](design/workspace.md) |
| Execution environments, Docker Sandboxes, commands in a sandbox or on this computer, network questions, sandbox preparation and `tesota setup` | 2026-09-25 | [Execution](design/execution.md) |
| Request record, flags, verifiers with claims, reviewer and lenses, ClaimCheck, refuter, origin check, correction loop with fix validation, assurance journal, forecast, `live:review` | 2026-09-25 | [Assurance](design/assurance.md) |
| Explorers, models by role, `tesota roles`, `tesota models`, `live:delegation` | 2026-09-25 | [Agents](design/agents.md) |
| Claude through an Anthropic API key or the operator's Claude Code | 2026-09-25 | [Agents](design/agents.md#model-routes) |
| OpenRouter, OpenCode Zen and OpenCode Go as routes, with OpenRouter's browser sign-in | 2026-09-26 | [Agents](design/agents.md#model-routes) |
| One model-session contract for every engine, with shared and live suites, time limits and token kinds | 2026-09-26 | [Agents](design/agents.md#the-engine-contract) |
| Responsive newest-first session navigation with precise lifecycle states and a narrow-terminal overlay | 2026-09-26 | [Sessions](design/sessions.md#the-shell) |

## Next

### 1. Features before daily use

The operator is adding further Tesota features before using it on a real
project. They are listed here as they are chosen.

- **Web access** for the agent and explorers (decision 024,
  [design](design/agents.md#web-access)): built 2026-09-26, so Tesota can
  research what the features after it need.
- **Switching the agent's model in a session, and handing off** to a fresh
  conversation (decision 026,
  [design](design/agents.md#changing-the-agents-model)): built 2026-09-26.
- **An advisor** the agent consults at hard decisions (decision 027,
  [design](design/agents.md#the-advisor)): built 2026-09-26, off by default.
- **Reasoning levels per role** (decision 029,
  [design](design/agents.md#reasoning-levels)): built 2026-09-26.
- **A native sandbox** (decision 030,
  [design](design/execution.md#native-sandbox)): commands confined with no
  Docker, no administrator rights and no question per command, on Microsoft
  MXC and qualified on each machine; built on Windows 11 24H2 and later
  2026-09-27. Linux and macOS are paused, 2026-09-26, until real use gives
  feedback.
- **Gateway routes** (decision 031): OpenRouter, OpenCode Zen and OpenCode Go,
  built 2026-09-26; OpenRouter's contract suite passes live on a free model.
  OpenCode refuses Zen's free models to clients other than its own, and Go
  answers only a key whose workspace has an active Go subscription, so
  neither OpenCode route has run a request yet; the routes' models are
  unmeasured as Tesota's roles, apart from Nemotron as a free judge.
- **Work beyond code** (decision 012's direction): a first real user works in
  public administration, with documents, spreadsheets, presentations and
  research, and the operator also uses agents for answers and actions on
  live systems. The [general work landscape](research/general-work-landscape.md)
  gathers how other agents serve that work, and decision 032 plans it
  ([design](design/work.md)): changes, answers and actions as kinds of
  result, folders as workspaces, and gates of stated strength that people
  can define. Folders and documents come first, then answers, then actions;
  her first real tasks decide the order within each. A plain folder as a
  workspace was built 2026-09-27
  ([design](design/workspace.md#a-folder-as-the-source)); documents and
  gates are next.
- **The agent's plan** (decision 033, [design](design/agents.md#the-plan)):
  built 2026-09-26, shown above the prompt as the agent's account.
- **Obligations** (decision 034, [design](design/assurance.md#obligations)):
  built 2026-09-26; the reviewer checks what each request asks for and each
  plan step the agent marked done, the refuter tests each gap, and confirmed
  gaps go to correction; turns that change no files are checked the same
  way. Steps confirmed by gates come with gates.
- **Jev for the answer check's first pass** (decision 035,
  [design](design/assurance.md#obligations)): built 2026-09-27; the `triage`
  role may use TypeSafe's Jev with the operator's own key, pinned to
  `typesafe:jev-1.13.0`, and skips a turn only below a 0.2 probability of
  being checkable. An error, a refusal, no key or no answer within ten
  seconds decide nothing, so the full check runs.
- **Session names** (decision 036, [design](design/sessions.md#the-shell)):
  built 2026-09-27; the shortened first request names a session at once,
  then the `namer` role writes a short title in the background, and
  `/rename` sets or suggests a name. The operator's name always wins.
- **Ideas to bring from `feat/evidence-attribution`**, a branch from
  2026-09-25 left unmerged, about 130 commits behind `dev`, whose decisions
  022 and 023 collide with `dev`'s. Each is to be rebuilt on `dev` with its
  tests, not merged:
  - **Failed checks compared with the base** (decision 039,
    [design](design/assurance.md#verifiers)): built 2026-09-28; a failed
    check runs again on the base, only a failure the change caused goes back
    to the agent, and a correction round keeps the base.
  - **Safer application.** Stop when any source file changed since the base;
    keep each replaced original; install without replacing; mark a partial
    effect "recovery required".

  Two measured runs on the branch are in [findings](findings.md).
- **Proposal: out-of-scope work and overengineering.** Tesota flags changes to
  what gets checked, deepens review for large or sensitive changes, and asks
  the reviewer to mark work beyond what was asked as the operator's call; but
  nothing measures whether that marking works, obligations catch only missing
  work, and nothing compares a change with its request. In order, each step
  only if the one before shows the need:
  1. An evaluation case that fixes what was asked and also adds an unrequested
     abstraction or refactor, to measure whether today's reviewer flags it.
  2. Obligations in both directions: "the result does nothing beyond the
     requests", judged and refuted like the other gaps, shown to the operator
     and never sent back automatically, since an extra may be welcome.
  3. A deterministic hint: changed files that no request or plan step names,
     shown for attention only, since legitimate changes often touch them.

### 2. Measurement on public benchmarks

Measure Tesota against benchmarks it did not write
([research](research/evaluation-landscape.md), decision 023). First
SWE-PRBench for review: `live:prbench` and the official scorer are built;
the 100-PR split is scored with the official judge, before and after
refutation, for the default reviewer and the operator's chosen one. Then
Terminal-Bench through Harbor for the whole loop against plain Pi on the same
model, which needs Tesota to run without its interactive shell, work the
session service also needs.

**Done when:** SWE-PRBench scores for at least two reviewer setups are
recorded in findings with the official judge, and Terminal-Bench compares
Tesota with plain Pi on one model.

### 3. Daily use on a real project

Use Tesota on SIACODE, then on Tesota's own changes, and fix what gets in the
way. Explorers are revisited with evidence from long sessions, and reviewer
and refuter models with the harder cases real work produces.

**Done when:** a normal week of real changes goes through Tesota, with
verification, review, a correction round and the operator's decision on the
whole record.

### 4. Session service and remote access

The [session service](design/sessions.md#planned-a-session-service): sessions
outlive the terminal, and the operator reaches them over SSH on a tailnet.
Building it waits for step 3.

The service owns every session's resources for several clients, which
decides what it runs on. Before building it, the session lifecycle is built
twice, on Effect v4's scopes and structured concurrency and on the platform's
own primitives that Tesota uses today (decision 038), and measured against
the same fault-injection tests with criteria registered first: exact outcome
classification and nothing left open for every failure or stop injected at
each acquisition step, then code size, the time and first-pass correctness of
a change made by the operator and by a coding agent, and readability for a
contributor who does not know Effect
([Effect runtime landscape](research/effect-runtime-landscape.md)). Effect is
adopted only if it wins on that evidence and 4.0 is stable by then.

**Done when:** over SSH from another device on the tailnet, the operator
attaches to running sessions, answers a pending question, disconnects
mid-work, and finds the work finished on reconnecting.

## Later

- Read `.devcontainer/devcontainer.json` as a toolchain definition, so
  repositories that already describe their environment need nothing
  Tesota-specific.
- A non-TypeScript repository and another platform.
- More execution providers once they pass the same live controls: WSL2,
  remote machines.
- A relay that offers Jev to users without their own TypeSafe key, once
  there are real users and TypeSafe agrees (decision 035).
- A review queue and notifications across sessions.
- Workflow profiles that choose verifiers, reviewers and rounds per
  repository, once two real alternatives exist.
- Web evidence in review, once real use shows reviews missing errors that
  only current documentation would catch: reviewers read only
  operator-pinned documentation sites, through an explorer, and every page
  they cite is saved with the review, so the refuter checks a web-based
  finding against the same saved pages and the review stays reproducible.
  Builds on web access (decision 024).
- A Java backend in the monorepo of a first user will need Java checks in the
  sandbox, per-part checks and nested instructions.

## Stopped

- **Gentle AI's review as a further reviewer**, 2026-09-25, before any code:
  its RDD is a complete assurance transaction, with its own consent, refuter,
  correction and authority, rather than a reviewer that returns findings, so
  integrating it would nest a second assurance loop inside Tesota's. Its ideas
  are adopted in the [assurance design](design/assurance.md). Details are in
  the [review landscape](research/agent-review-landscape.md#spike-result-2026-09-25).
