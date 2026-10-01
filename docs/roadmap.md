# Roadmap

This page owns current status and priorities. The [design](design/overview.md)
describes built behavior; the [guide](guide/using-tesota.md) explains how to use
it. Earlier proposals and evaluations remain in Git history.

## Status

Tesota is an unpublished, pre-release terminal coding agent. It works in the
operator's project, records each turn, runs checks and review on it, and lets
the operator keep, revert or redo the turn with `/keep`, `/revert` and
`/redo`; a folder of documents, or a second session, works in a separate
workspace and applies or rejects. On Windows, commands can run
in a qualified WSL sandbox; otherwise host commands ask for approval.
`Shift+Tab` switches between Read only, Accept edits and Full access. The
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
- Finish working in the source. Built: one shadow repository per source;
  turns recorded in the operator's project and decided with `/keep`,
  `/revert` and `/redo`, a revert never overwriting a later edit; secret files
  hidden and `.git` read-only in the WSL sandbox, with the agent told what is
  hidden; base checks in a checkout of their own; a separate workspace for a
  folder, a second session, or any session that chooses one with `/isolate`
  before its first request, with the disk each holds listed by `tesota
  prune`. Not yet run with a real model in the shell: use it on a real
  project next. Base checks outside the WSL sandbox wait until real use shows
  they matter.
  [Workspace](design/workspace.md#planned)
- Scope behavior was measured on cases that tempt the agent to make unrelated
  changes, registered before any run: five temptations and a control in
  `live:agent`. On 2026-09-30, `claude-code:sonnet` kept all 10 tempted runs in
  scope and resolved, and reported the temptation in 5 of 6 where it could.
  With nothing to improve, the working agent's prompt gets no scope
  instruction. Revisit with harder cases drawn from real drift in daily use.
  [Issue #165](https://github.com/sequelcore/tesota/issues/165)
- Requests whose premise is false: behavior documented as intended, code
  that does not exist, a vendored defect, a symptom that does not occur. The
  review now reports a false premise to the operator and never sends it back
  to the agent, and the answer check leaves a rightly declined one to the
  operator. The working agent still acts on them (15 of 16 in the
  2026-09-30 baseline, on `codex:gpt-6-luna` and `claude-code:haiku`); a
  change to its prompt is next, measured with `live:agent --set=premise`
  against the fix, scope and question results.
  [Assurance](design/assurance.md#the-requests-premise)
- Route the answer check by what a turn holds. Jev's first pass already
  decides the request's kind from the requests alone; add journaled real turns
  to `live:answer`'s cases, then send each part to the cheapest check that
  settles it. A cheaper reviewer tier needs escalation that never trusts its
  clean verdicts, and a measured saving.
  [Assurance](design/assurance.md#planned-routing-the-answer-check)
- Run checks and review beside the agent's next request, on a frozen copy of
  the candidate, so a queued message no longer waits for them. Measure it on
  journaled sessions first. [Assurance](design/assurance.md#planned-review-beside-the-next-request)
- Add an Auto mode between Accept edits and Full access, as Claude Code's
  auto mode and Codex's auto-review do: a reviewer model allows commands on
  this computer and asks the operator about risky ones. Register safe and
  risky command cases first, and offer it only when it asks for every risky
  case and saves approvals on safe ones; its allowed commands never count as
  the operator's. Custom behavior modes, such as a grilling or triage mode,
  wait for daily use, under workflow profiles.
  [Execution](design/execution.md#where-commands-run)
- Put the sessions that wait on the operator, for an approval or an answer,
  first in the sidebar, as Codex's agents view groups "Needs input" first,
  and name how many wait in the footer while the sidebar is hidden, so a
  blocked session is seen without looking for it.
  [Sessions](design/sessions.md)
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
model through Terminal-Bench and Harbor. `tesota run` is the noninteractive
way to run Tesota it needs; Harbor's adapter for it is not built.
[Evaluation method](development.md#evaluations)

### 4. Use Tesota daily

Use it on a private project and then on Tesota's own changes. Revisit explorer
and reviewer choices with evidence from those sessions. A normal week of real
changes should include checks, review, correction where needed, and the
operator's decision on the complete result. Passing checks and a clean review
remain separate from human acceptance.

Once others contribute, apply the same roles to their pull requests and
issues: a review of a pull request with a verdict computed from its facts,
and a reported defect reproduced by a test that fails on the base and passes
on the fix. Nothing is sent to GitHub without the operator's approval.
[Contributions from others](design/assurance.md#planned-contributions-from-others)

### 5. Keep sessions after the terminal closes

The proposed session service would let clients attach to long-lived sessions
over local IPC and reach them remotely through SSH on a tailnet. It waits for
daily use. Before choosing an orchestration runtime, compare Effect v4 and
the current platform primitives
against the same registered fault-injection cases; adopt Effect only if it wins
on observed outcomes and is stable.

With the service, add a sessions overlay, as the Accounts panel is one, for
what the sidebar cannot hold: sessions across repositories, sessions running
after the terminal closed, status filters and search, as Codex's agents view
(`← for agents`) offers over its background server. It complements the
sidebar, which stays the always-visible signal. **Needs deeper analysis
first:** compare Codex's agents view, Claude Code's background agents and the
sidebar on real multi-session use (how many sessions, how often one waits,
how it is noticed) before choosing its layout, grouping and keys.

## Later

- Read `.devcontainer/devcontainer.json` as a repository toolchain definition.
- Exercise a non-TypeScript repository and another operating system.
- Improve verifier feedback for correction on real tasks: preserve the
  original requirement, surface the failing obligation and its source when
  available, and distinguish a demonstrated violation from an unresolved
  proof, unsupported behavior or a check that could not finish. Preserve
  editable proof work when source artifacts are regenerated, and refresh
  evidence when code, contracts, proof files or their dependencies change.
- Evaluate additional verification methods and prover backends only for
  concrete properties current methods cannot establish effectively. Record
  each method's supported semantics, assumptions and limits. Compare repair
  success, missed defects, specification weakening, time and tokens on the
  same cases. Targeted checks may guide repair; final assurance must cover
  the declared candidate and claim. Adopt an optimization only for a
  measured benefit without weakening that coverage.
- Evaluate a Java verifier on an existing consumer's precise domain rule,
  after exercising the current turn workflow on a real project. Establish
  the supported language and library subset before selecting a tool or
  building one. Integrate a demonstrated method with its assumptions,
  diagnostics and evidence bound to the candidate; measure correction
  against an unchanged request, including specification weakening. The
  verifier's implementation and consumers' product roadmaps remain outside
  Tesota's roadmap.
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
