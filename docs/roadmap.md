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
complete loop has run on throwaway and evaluation repositories, and in daily
use on an outside Windows project and on Tesota's own issues. The current
record of that use starts on 2026-10-01; what it surfaced is in
[issue #243](https://github.com/sequelcore/tesota/issues/243). See the
[user guide](guide/using-tesota.md) for the workflow and limits.

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
- The working agent proves LemmaScript contracts during its turn, as
  LemmaScript's own loop and Midspiral's lemmafit do: in a repository with
  `//@` files it gets `prove` and guidance to keep contracts provable. On
  registered cases, Sonnet, GPT-6 Luna and GPT-6.1 Sol left the proof failing
  on 44 of 45 invariant cases without either; Sonnet and Sol proved all with
  the guidance alone, and Luna proved all only with the tool, for about 5k
  more tokens per turn. A case that tempts weakening the contract drew no
  weakening from Luna or Sol in any arm; Sol proved it every time with the
  guidance alone, while Luna, with the tool, proved 3 of 5 and reported the
  unproved obligation in the other two, after one failed run. A note in the
  failed tool reply that the work is not finished raised that case from 9 to
  15 of 20 and ended single-attempt stops, consistently over two rounds but
  not yet established (p ≈ 0.10); confirm it on real sessions. Next: measure
  whether the agent should add contracts where the repository's instructions
  ask for them. What the agent proves stays feedback; Tesota's run on the
  candidate stays the evidence.
  [Agents](design/agents.md#proofs-while-it-works)
  [Issue #294](https://github.com/sequelcore/tesota/issues/294)
- Scope behavior was measured on cases that tempt the agent to make unrelated
  changes, registered before any run: five temptations and a control in
  `live:agent`. On 2026-09-30, `claude-code:sonnet` kept all 10 tempted runs in
  scope and resolved, and reported the temptation in 5 of 6 where it could.
  With nothing to improve, the working agent's prompt gets no scope
  instruction. Revisit with harder cases drawn from real drift in daily use.
  [Issue #165](https://github.com/sequelcore/tesota/issues/165)
- Requests whose premise is false: behavior documented as intended, code
  that does not exist, a vendored defect, a symptom that does not occur. The
  working agent checks a request's claims and leaves a false premise to the
  operator (8 of 8 on `codex:gpt-6-luna` and on `codex:gpt-6.1-sol` on
  2026-10-02, from 0 and 4), the review reports one and never sends it
  back, and the answer check leaves a rightly declined one to the operator.
  Revisit with false premises drawn from daily use.
  [Assurance](design/assurance.md#the-requests-premise)
- Route the answer check by what a turn holds. Jev's first pass already
  decides the request's kind from the requests alone; add journaled real turns
  to `live:answer`'s cases, then send each part to the cheapest check that
  settles it. A cheaper reviewer tier needs escalation that never trusts its
  clean verdicts, and a measured saving.
  [Assurance](design/assurance.md#planned-routing-the-answer-check)
- Verify in proportion to the change. Related tests in each round, with
  the whole check before the operator's decision, are built; the journal
  records each check's duration and its base run's. Measure the saving on
  journaled turns, then add tests the related form misses, no related tests
  for a round with no code, correction rounds reviewed by what they changed,
  and a light review only for a change with no code.
  [Assurance](design/assurance.md#planned-verification-in-proportion-to-the-change)
- Consider a Proposals tab in the result panel for repository settings
  Tesota can suggest: the sensitive paths, from names and imports, and a
  related form for a check typed without one. Asking before the first review
  was tried and dropped: it listed about forty files and held the session for
  what the default already covers. Build it only if journaled reviews show
  the default's noise costs enough to matter.
  [Assurance](design/assurance.md#planned-proposals-the-operator-confirms)
- Consider scope as a first-pass question: whether a turn's changes stay
  within what was asked. The reviewer judges scope growth today, as an
  operator disposition measured by `live:review --set=scope`; a typed
  decision model could flag it in a fraction of a second, but only if, on
  registered cases, it flags what the reviewer flags and costs less.
- Consider flagging a turn whose agent is stuck: repeating the same tool
  calls or failing the same command without progress. Tesota already records
  each tool call and its outcome, the evidence such a judge reads; a typed
  decision model could judge it while the turn runs and tell the operator,
  never stop the agent on its own. Register cases from stuck turns seen in
  daily use before choosing a judge or a threshold.
- Run checks and review beside the agent's next request, on a frozen copy of
  the candidate, so a queued message no longer waits for them. Measure it on
  journaled sessions first. [Assurance](design/assurance.md#planned-review-beside-the-next-request)
- Add an Auto mode between Accept edits and Full access, as Claude Code's
  auto mode and Codex's auto-review do: a judge allows commands on this
  computer and asks the operator about risky ones. Fixed rules for risky
  command patterns come first and only ever ask. Compare two judges on the
  same registered safe and risky command cases: a reviewer model, and Jev,
  which agent harnesses already use for this gate in about a tenth of a
  second, where a reviewer session takes seconds. Offer the mode only with a
  judge that asks for every risky case and saves approvals on safe ones; a
  judge that fails, times out or does not decide asks. Its allowed commands
  never count as the operator's. Custom behavior modes, such as a grilling
  or triage mode, wait for daily use, under workflow profiles.
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
