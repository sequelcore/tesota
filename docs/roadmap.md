# Roadmap

This page owns current status and priorities. The [design](design/overview.md)
describes built behavior; the [guide](guide/using-tesota.md) explains how to use
it. Earlier proposals and evaluations remain in Git history.

## Status

Tesota is an unpublished, pre-release terminal coding agent. It works in the
operator's project, records each turn, runs checks and review on it, and lets
the operator keep or revert the turn; a second session works in a separate
workspace and applies or rejects. On Windows, commands can run
in a qualified WSL sandbox; otherwise host commands ask for approval. The
complete loop has run on throwaway and evaluation repositories. Daily use on a
real project has not started. See the [user guide](guide/using-tesota.md) for
the workflow and limits.

## Next

### 1. Prepare the release and exercise the current workflow

- Finish release identity: clear the name, domain and social handles. Public
  app listing on OpenRouter follows launch preparation.
  [Overview](design/overview.md#name-and-identity)
- Use the WSL sandbox as the default on a real project, including its toolchain
  preparation and the option to approve one command on the host. Correct the
  obstacles real use reveals. [Execution](design/execution.md)
- Finish working in the source. Built: one shadow repository per source,
  turns recorded in the operator's project with keep and revert, secret files
  hidden and `.git` read-only in the WSL sandbox, base checks in a checkout of
  their own, and a separate workspace for a second session. Next: one
  `node_modules` per repository shared by its sessions, then an isolated
  workspace for any session that asks, with its cost stated, then removing
  what only the old default path used. Use it on a real project first.
  [Workspace](design/workspace.md#planned)
- Evaluate scope behavior on cases that tempt the agent to make unrelated
  changes. The reviewer's extra-work check is built, but
  the working agent's prompt has no measured scope intervention yet. Register
  the cases before changing it; use `live:agent` and record the result with
  the change. [Issue #165](https://github.com/sequelcore/tesota/issues/165)
- Route the answer check by what a turn holds. Jev's first pass already
  decides the request's kind from the requests alone; add journaled real turns
  to `live:answer`'s cases, then send each part to the cheapest check that
  settles it. A cheaper reviewer tier needs escalation that never trusts its
  clean verdicts, and a measured saving.
  [Assurance](design/assurance.md#planned-routing-the-answer-check)
- Exercise model routes that have not completed a live request. OpenCode Zen
  restricts its free models to its own client, and OpenCode Go requires an
  active subscription. Do not present either route as live-qualified until it
  passes the opt-in live contract suite. [Model routes](design/agents.md#model-routes)

### 2. Extend the kinds of work

The current loop handles file changes. A plain folder can already be a source;
documents, user-defined gates, source-checked answers and approved actions
are planned in that order, with real users' tasks deciding the detail. Do not
describe these planned results as release features.

### 3. Measure against public benchmarks

Score at least two reviewer setups on SWE-PRBench's 100-pull-request split
with its official judge, before and after refutation, and record the results
with the evaluation change. `live:prbench` and the scorer are built; scores are
not yet recorded here. Then compare the whole loop against plain Pi on one
model through Terminal-Bench and Harbor. That comparison needs a noninteractive
way to run Tesota. [Evaluation method](development.md#evaluations)

### 4. Use Tesota daily

Use it on a private project and then on Tesota's own changes. Revisit explorer
and reviewer choices with evidence from those sessions. A normal week of real
changes should include checks, review, correction where needed, and the
operator's decision on the complete result. Passing checks and a clean review
remain separate from human acceptance.

### 5. Keep sessions after the terminal closes

The proposed session service would let clients attach to long-lived sessions
over local IPC and reach them remotely through SSH on a tailnet. It waits for
daily use. Before choosing an orchestration runtime, compare Effect v4 and
the current platform primitives
against the same registered fault-injection cases; adopt Effect only if it wins
on observed outcomes and is stable.

## Later

- Read `.devcontainer/devcontainer.json` as a repository toolchain definition.
- Exercise a non-TypeScript repository and another operating system.
- Add remote execution providers only after they pass the same live controls.
- Consider a Jev relay only with real users and TypeSafe's agreement.
- Add a review queue, cross-session notifications, or workflow profiles when
  actual use establishes their need.
- Add pinned web evidence to review only if real reviews miss errors that
  require current documentation.
- Add executable probes for findings the refuter cannot settle if evaluations
  show those findings in practice.
- Evaluate document gates and nested instructions with the first user's Java
  backend and document tasks.
