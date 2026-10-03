# Overview

**Tesota is an open-source coding agent that reviews every turn it takes in
your project, and reverts one without overwriting your own edits.** It
records the exact content of each turn, so you inspect the changes, check
results and review bound to that content, then keep the turn or revert it. A
folder of documents, or a second session, works in a separate copy you apply
from.
The [roadmap](../roadmap.md) owns status and priorities; this page and its
siblings describe what is built unless a section explicitly says planned.

| Design | Covers |
| --- | --- |
| [Workspace](workspace.md) | The shadow repository, turns in your project with keep and revert, and the separate copy a second session applies from |
| [Execution](execution.md) | Where commands run, a sandbox or this computer, when the operator is asked, and network |
| [Assurance](assurance.md) | Checks, verifiers, review, refutation, correction, the journal and the forecast |
| [Proofs](proofs.md) | LemmaScript proofs from the agent's turn to the operator's decision: what a proof covers, checking contracts, where each problem goes |
| [Agents](agents.md) | The working agent, explorers, the advisor and the model for each role |
| [Sessions](sessions.md) | The shell and saved sessions |

## Principles

1. A check states what it observed, about which exact content, under which
   conditions.
2. Evidence for earlier content does not carry over after the content changes.
3. Failures, timeouts, cancellations and unconfirmed effects stay distinct.
   None of them becomes a pass.
4. Checks, review, human acceptance and application are separate facts.
5. Model output and check results never grant authority. The operator
   approves commands, or sets a sandbox that makes approval unnecessary, and
   keeps, reverts or applies changes.
6. Verification is proportional and errs toward checking. Each turn gets the
   cheapest check that can settle it: one that changes files always gets
   checks and review, at a depth set by what it changes; one that only
   answers gets a first pass that decides whether the full check is needed.
   A step that fails or cannot decide runs the full check, and every skip is
   recorded and shown with its reason
   ([depth](assurance.md#depth), [first pass](assurance.md#obligations)).

## Flow

```text
request
  -> working agent        Pi session in the project, or in a copy for a second session; file
                          tools confined to it, commands in the session's execution environment
  -> snapshot             the turn as the trees before and after it: changed paths, diff and tree id
  -> first pass           a turn that changed no files: does its answer need the full check?
                          a typed decision model such as Jev, or a model; undecided runs it
  -> checks and verifiers approved commands, Oxlint and LemmaScript on that tree
  -> review               reviewers, origin check, refuter; deeper when the turn touches tests,
                          what checks it, sensitive files or much code, with a forecast first
  -> correction           failed checks and confirmed fixable findings go back, at most twice
  -> decision             /keep | /revert | /redo, at any time      (apply | reject | continue in a copy)
       keep:   the turn's tree becomes the base
       revert: files that still hold the turn's content go back to the tree before it
       redo:   the reverted turn goes back where its files still hold the tree before it
       apply:  only files whose source still matches the base are written
```

## Components

Tesota owns the workspace, execution environments, checks, review, correction
and application. Pi (`@earendil-works/pi-*`) is the agent engine and terminal
toolkit, used through its public APIs; Tesota does not reimplement the agent
loop or OAuth. Models are reached through routes: Codex through Pi's OAuth
support, Anthropic's API through Pi with an API key, the operator's Claude
subscription through Claude Code, run by the Claude Agent SDK, and OpenRouter
and OpenCode's Zen and Go through Pi with their keys
([agents](agents.md#model-routes), [authentication](../guide/authentication.md)).
Every role runs through one session interface over the two engines; adding a
route means re-exercising the roles on it.

Pi supplies the login, token refresh and agent mechanics. Pi types stay inside
adapters so a concrete unsupported behavior can be addressed at that boundary.

## Direction

Tesota aims to be a general-purpose agent harness with verification as a core
behavior: useful with its own shell and tools, with native checks and reviews
and room for methods users and the community add. Coding comes first because
it has exact results and executable oracles; the general coding loop was built
before per-capability guarantees, after an earlier design qualified every
capability before anyone could use it. A capability is added for a real
consumer, measured when it claims to improve results, and removed without
compatibility shims when it stops earning its place: there are no external
consumers of Tesota's internal contracts yet.

Public wording follows the product: what Tesota does for the person first,
why its evidence matters second, mechanism last. It never claims safety,
reliability or autonomy beyond what the evidence supports, and never
presents a passing check as proof that a change does what was asked.

## Name and identity

**The name.** Tesota takes its name from *Olneya tesota*, the desert
ironwood, *palo fierro* in Spanish, a tree of the Sonoran Desert
([Arizona-Sonora Desert Museum](https://www.desertmuseum.org/programs/ifnm_ironwoodtree.php)).
Its wood is dense enough to sink in water, and some trees are estimated at
800 years old. It is a nurse tree: its shade and shelter help other plants
establish themselves beneath it, and more than 500 species of plants and
animals depend on it, which makes it a keystone of its habitat
([Friends of Ironwood Forest](https://ironwoodforest.org/about/the-monument/learn/desert-ironwood-tree/)).
For the project, the name suggests **a durable foundation that supports
growth**. That is its intended meaning, not a literal translation, a
dependability claim or an architecture term.

**What Tesota is called.** For the release, call it an **open-source coding
agent** and explain its distinguishing workflow directly:

> Tesota reviews every turn it takes in your project, and reverts one without
> overwriting your own edits. It records the exact content of each turn and
> shows the diff, checks and independent review, bound to that content, so you
> decide what stays in your files.

The terminal's optional short line is **Every turn is reviewed; reverting
never overwrites your edits.** It describes the current workflow; it is not a
slogan or a claim that passing checks prove correctness. It rests on a
difference read in the harnesses' own code on 2026-09-29: Claude Code's
rewind and OpenCode's revert write a turn's earlier content over a file
whatever it holds now (`applySnapshot` in Claude Code's `utils/fileHistory.ts`,
`revert` in OpenCode's `snapshot/index.ts`), while Tesota's leaves a file
edited since the turn as it is and names it. Work beyond code remains a
direction, not a release claim.

**Names of the parts.**

| Name | What it is |
| --- | --- |
| **Tesota** | The product and the coding agent |
| `tesota` | The package and the command |
| **Tesota Shell** | The terminal the command opens ([sessions](sessions.md)) |
| Pi | The agent engine, not Tesota's identity |
| Claude Code, OpenRouter, OpenCode | Routes to models ([agents](agents.md#model-routes)), not parts of Tesota |
| Oxlint, LemmaScript and Dafny | Verifiers Tesota runs, not modes of it |

**Voice.** Calm engineering precision: direct, specific and candid about
limits. Observable behavior comes before adjectives; safe, trusted,
reliable, autonomous and production-ready are used only where the evidence
supports that exact wording. Tesota does not claim that other agents lack
tests, approvals, sandboxes or review; it claims that the path from work to
evidence to the operator's decision is what it is organized around.

## Trust

Repository content and model output are untrusted. The file tools resolve
every path against the project, or the copy, and refuse anything outside it,
including through links; edit and write also refuse `.git`, and every file
tool refuses the files hidden as possible credentials. Repository
instructions in `AGENTS.md` or `CLAUDE.md` are passed to the agent and the
reviewers as context, never as authority. Credentials, operator state, model
routing and execution permissions live in code and in Tesota's own directory
(`~/.tesota`), never in a repository.

## Owners

| Owner | Responsibility |
| --- | --- |
| `cli.ts` | Commands and shell startup |
| `tesota-shell.ts` | Surface-independent loop: request, checks, review, correction, decision |
| `session-decisions.ts`, `tesota-shell-question.ts`, `verification/question-rule.ts` | Every point where a session waits for someone, the shell's typed prompts and choice panels, and its proved shortcut rule |
| `session-engine.ts`, `semaphore.ts` | Per-session composition of workspace, environment, agent, review and application, the commands on a session, what it holds and its release, and the bound on what runs at once; written to a narrow output any surface provides |
| `tesota-shell-command.ts` | The shell: its terminal, creating, showing and closing sessions, and running each session's loop |
| `run-command.ts`, `verification/run-policy-rule.ts` | `tesota run`: one request without the shell, its decisions answered by the run's flags with a proved rule, its output and exit code |
| `tesota-shell-terminal.ts`, `tesota-shell-sidebar.ts`, `tesota-shell-theme.ts`, `tesota-shell-inspection.ts`, `shell-progress.ts`, `verification/sidebar-rule.ts` | Terminal composition and input, session navigation and its proved state and responsive rules, themes, result panel and status |
| `tesota-shell-diff.ts` | The result panel's diff view, from git's unified diff |
| `tesota-shell-transcript.ts` | How a conversation and a review record look, built on pi-tui components |
| `terminal-output.ts` | What a command's output reads as once drawn: no colors, cursor sequences or redrawn progress |
| `shell-session-store.ts` | Saved sessions, approved checks, allowed network destinations and measured review costs per repository |
| `source-shadow.ts`, `workspace-checkout.ts`, `source-snapshot.ts`, `workspace.ts` | The shadow repository of every source, independent clones of it, capturing the source's changes, snapshots and updates |
| `source-session.ts`, `verification/review-start-rule.ts`, `verification/source-holder-rule.ts` | A session working in the source: its turns as pairs of shadow trees, keep, revert of the latest turn, the turns a review judges, from the first one the last review did not cover whole, and which session holds the operator's files, proved |
| `request-record.ts` | The operator's requests behind the pending changes |
| `workspace-apply.ts`, `verification/application-rule.ts`, `recover-command.ts`, `workspace-prune.ts` | Application with its store, journal and proved admission and outcome rules, and `tesota recover`; which workspaces `tesota prune` may remove |
| `route-accounts.ts`, `verification/route-removal-rule.ts`, `verification/usage-reader-rule.ts` | Which account each route is signed in to, masked unless asked, routes sharing one, and roles spread across routes that draw on one; which route reads a shared account's usage, and what signing a route in, out or removing it does to the route and its roles, both proved |
| `claude-code-transcripts.ts` | Removing a closed session's Claude Code conversations by their recorded ids, and finding Claude Code's folders of isolated workspaces that no longer exist, for `tesota prune` |
| `repository-git.ts`, `windows-system.ts` | Git without ambient config, hooks or network; Windows' own programs, never found through PATH |
| `execution-environment.ts`, `execution-providers.ts` | The provider-neutral execution interface, choosing a mode and provider, `tesota setup` |
| `host-environment.ts`, `docker-sandboxes-environment.ts`, `docker-sandboxes-kit.ts`, `toolchain.ts`, `languages.ts` | The two providers, the cached sandbox image, and a repository's setup: the runtimes it pins, the languages its files show, and the stages every sandbox runs |
| `execution-controls.ts` | The controls every provider must pass, for the live suites and qualification |
| `wsl-environment.ts`, `bubblewrap-sandbox.ts`, `bubblewrap-sandbox-server.ts`, `egress-proxy.ts`, `verification/setup-network-rule.ts` | The WSL sandbox: its provider on Windows, its bubblewrap process inside WSL, and the allowlist proxy its commands reach the network through, with its proved setup phase |
| `execution-qualification.ts`, `sandbox-command.ts`, `verification/sandbox-qualification.ts` | Qualification on the operator's machine, `tesota sandbox`, and their proved rules |
| `command-rules.ts`, `verification/command-rule.ts` | Which commands run on this computer without asking: reading a command, the rules the operator saves, and their proved match |
| `verification/permission-mode.ts` | The operator's permission modes (Read only, Accept edits, Full access): whether edits are allowed, where commands run, when they ask, and Shift+Tab's cycle, proved |
| `verification/toolchain-refresh-rule.ts` | When a toolchain the repository declares mid-session is set up in the sandbox: only on the operator's yes, and never where the sandbox sets up only when prepared, proved |
| `workspace-checks.ts`, `verification/oxlint*.ts`, `verification/lemmascript-verifier.ts` | Verifier results with claim and limits: approved commands, Oxlint, LemmaScript with Dafny |
| `integrations/prove-tool.ts` | The working agent's own LemmaScript proof run, feedback while it works, on in a repository with `//@` files |
| `proof-guarantees.ts`, `verification/proof-cover-rule.ts` | What a candidate's contracts guarantee, for the Guarantees tab, and the proved rule for which changed lines a proof covers |
| `proof-mutation.ts` | Proof-based mutation of each changed, proved contract, reported in the Guarantees tab |
| `test-report.ts`, `verification/check-origin-rule.ts` | Reading a check's JUnit XML reports, and the proved rule for whose failure a check or test is |
| `verification-changes.ts` | Flagging changes to tests, check configuration, CI, specifications and scripts |
| `review.ts`, `integrations/pi-reviewer.ts`, `integrations/pi-claimcheck.ts` | The reviewer contract, Tesota's reviewer and lenses, and ClaimCheck's method |
| `integrations/pi-refuter.ts`, `integrations/pi-fix-validator.ts` | The refuter and the fix validator |
| `diff-lines.ts`, `finding-origin.ts`, `verification/finding-origin-rule.ts` | Reading changed lines, checking each finding's origin, and the proved rule |
| `review-depth.ts`, `review-forecast.ts`, `verification/review-estimate.ts` | Review depth, measured costs and the forecast, and its proved rules |
| `correction.ts`, `assurance-journal.ts` | What goes back to the agent, and the per-workspace assurance journal, which also holds where the next review begins and a correction sent that no review has judged |
| `integrations/pi-coding-session.ts` | Pi sessions, confined tools, command approval, cancellation, activity and token counts |
| `secret-files.ts` | Which files are hidden from the agent's tools and sandboxed commands |
| `integrations/pi-explorer.ts`, `integrations/pi-explore.ts`, `verification/helper-answer.ts` | Read-only explorers, the `explore` tool, the page reader, and the proved rules for helpers' answers and allowances |
| `integrations/advisor.ts`, `integrations/advisor-session.ts` | The advisor: the `advisor` tool, its allowance, the conversation it reads, and its session |
| `model-roles.ts`, `models-command.ts`, `judge-warnings.ts`, `verification/judge-independence.ts` | The route and model for each role, `tesota roles`, the `tesota models` catalog, and warnings when a judge shares its author's model or lab |
| `integrations/model-session.ts`, `integrations/claude-code-session.ts` | Starting a role's session on Pi or on Claude Code, and Tesota's tools inside Claude Code |
| `integrations/tesota-credentials.ts`, `integrations/codex-login.ts`, `auth.ts` | Codex OAuth and Anthropic API key storage, Codex login, and `tesota auth` |
| `review-evaluation.ts`, `live-review.ts`, `delegation-evaluation.ts`, `live-delegation.ts` | The evaluations with known truth and their live runners |

## Current limits

- Exercised live only on Windows.
- Changes to symbolic links and submodules cannot be applied.
- Without a sandbox, approved commands run on the host without isolation.
- At most two sessions work at once; model rate-limit errors are not retried.
- The complete loop with review and correction has run on throwaway and
  evaluation repositories, and in daily use on real projects on Windows; the
  current record of that use starts on 2026-10-01.
