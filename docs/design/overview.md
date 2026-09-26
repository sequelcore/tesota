# Overview

**Tesota is an open-source agent for work that carries its evidence.** You
describe what you need, a coding agent does it in a separate copy of your
repository, and you review the exact changes and what the checks establish
before anything reaches your files. The [roadmap](../roadmap.md) owns status
and priorities; this page and its siblings describe the design as it is.

| Design | Covers |
| --- | --- |
| [Workspace](workspace.md) | The separate copy, keeping it current, and applying reviewed work |
| [Execution](execution.md) | Where commands run, a sandbox or this computer, when the operator is asked, and network |
| [Assurance](assurance.md) | Checks, verifiers, review, refutation, correction, the journal and the forecast |
| [Agents](agents.md) | The working agent, explorers, the advisor and the model for each role |
| [Sessions](sessions.md) | The shell, saved sessions, and the planned session service |

## Principles

1. A check states what it observed, about which exact content, under which
   conditions.
2. Evidence for earlier content does not carry over after the content changes.
3. Failures, timeouts, cancellations and unconfirmed effects stay distinct.
   None of them becomes a pass.
4. Checks, review, human acceptance and application are separate facts.
5. Model output and check results never grant authority. The operator
   approves commands, or sets a sandbox that makes approval unnecessary, and
   applies changes.

## Flow

```text
request
  -> working agent        Pi session in the workspace checkout; file tools confined to it,
                          commands in the session's execution environment
  -> snapshot             all work staged: changed paths, diff and Git tree id
  -> checks and verifiers approved commands, Oxlint and LemmaScript on that tree
  -> review               reviewers, origin check, refuter; a forecast first when deep
  -> correction           failed checks and confirmed fixable findings go back, at most twice
  -> decision             apply | reject | keep working
       apply:  only files whose source still matches the base are written
       reject: the workspace returns to its base
```

## Components

Tesota owns the workspace, execution environments, checks, review, correction
and application. Pi (`@earendil-works/pi-*`) is the agent engine and terminal
toolkit, used through its public APIs; Tesota does not reimplement the agent
loop or OAuth. Models are reached through three routes: Codex through Pi's OAuth support,
Anthropic's API through Pi with an API key, and the operator's Claude
subscription through Claude Code, run by the Claude Agent SDK
([agents](agents.md#model-routes), [authentication](../guide/authentication.md)).
Every role runs through one session interface over the two engines; adding a
route means re-exercising the roles on it.

Pi was chosen over extracting Kiln's authentication and provider code because
Pi already supplies the login, token refresh and agent mechanics, and keeping
Pi types inside adapters contains a future replacement. Revisit that only if
a concrete unsupported behavior blocks the product.

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

The name comes from *Olneya tesota*, the Sonoran Desert ironwood tree; it is
not a dependability claim, and trademark clearance has not been done. Tesota
began as a deliberate reset of Kiln, whose code and roadmap it does not
inherit ([Kiln reference](../research/kiln.md)).

## Trust

Repository content and model output are untrusted. The file tools resolve
every path against the workspace checkout and refuse anything outside it,
including through links; edit and write also refuse `.git`. Repository
instructions in `AGENTS.md` or `CLAUDE.md` are passed to the agent and the
reviewers as context, never as authority. Credentials, operator state, model
routing and execution permissions live in code and in Tesota's own directory
(`~/.tesota`), never in a repository.

## Owners

| Owner | Responsibility |
| --- | --- |
| `cli.ts` | Commands and shell startup |
| `tesota-shell.ts` | Surface-independent loop: request, checks, review, correction, decision |
| `tesota-shell-command.ts` | Per-session composition of workspace, environment, agent, review and application |
| `tesota-shell-terminal.ts`, `tesota-shell-sidebar.ts`, `tesota-shell-theme.ts`, `tesota-shell-inspection.ts`, `shell-progress.ts`, `verification/sidebar-rule.ts` | Terminal composition and input, session navigation and its proved state and responsive rules, themes, result panel and status |
| `tesota-shell-diff.ts` | The result panel's diff view, from git's unified diff |
| `tesota-shell-transcript.ts` | How a conversation looks, built on pi-tui components |
| `shell-session-store.ts` | Saved sessions, approved checks, allowed network destinations and measured review costs per repository |
| `workspace-checkout.ts`, `source-snapshot.ts`, `workspace.ts` | Independent clones, capturing uncommitted source changes, snapshots, updates and the request record |
| `workspace-apply.ts`, `workspace-prune.ts` | Conflict-checked application and its journal; which workspaces `tesota prune` may remove |
| `repository-git.ts`, `windows-system.ts` | Git without ambient config, hooks or network; Windows' own programs, never found through PATH |
| `execution-environment.ts`, `execution-providers.ts` | The provider-neutral execution interface, choosing a mode and provider, `tesota setup` |
| `host-environment.ts`, `docker-sandboxes-environment.ts`, `docker-sandboxes-kit.ts`, `toolchain.ts` | The two providers, the cached sandbox image, and reading a repository's pinned runtimes |
| `execution-controls.ts` | The controls every provider must pass, for the live suites and qualification |
| `workspace-checks.ts`, `verification/oxlint*.ts`, `verification/lemmascript-verifier.ts` | Verifier results with claim and limits: approved commands, Oxlint, LemmaScript with Dafny |
| `verification-changes.ts` | Flagging changes to tests, check configuration, CI, specifications and scripts |
| `review.ts`, `integrations/pi-reviewer.ts`, `integrations/pi-claimcheck.ts` | The reviewer contract, Tesota's reviewer and lenses, and ClaimCheck's method |
| `integrations/pi-refuter.ts`, `integrations/pi-fix-validator.ts` | The refuter and the fix validator |
| `diff-lines.ts`, `finding-origin.ts`, `verification/finding-origin-rule.ts` | Reading changed lines, checking each finding's origin, and the proved rule |
| `review-depth.ts`, `review-forecast.ts`, `verification/review-estimate.ts` | Review depth, measured costs and the forecast, and its proved rules |
| `correction.ts`, `assurance-journal.ts` | What goes back to the agent, and the per-workspace assurance journal |
| `integrations/pi-coding-session.ts` | Pi sessions, confined tools, command approval, cancellation, activity and token counts |
| `integrations/pi-explorer.ts`, `integrations/pi-explore.ts`, `verification/helper-answer.ts` | Read-only explorers, the `explore` tool, the page reader, and the proved rules for helpers' answers and allowances |
| `integrations/advisor.ts`, `integrations/advisor-session.ts` | The advisor: the `advisor` tool, its allowance, the conversation it reads, and its session |
| `model-roles.ts`, `models-command.ts`, `judge-warnings.ts`, `verification/judge-independence.ts` | The route and model for each role, `tesota models`, and warnings when a judge shares its author's model or lab |
| `integrations/model-session.ts`, `integrations/claude-code-session.ts` | Starting a role's session on Pi or on Claude Code, and Tesota's tools inside Claude Code |
| `integrations/tesota-credentials.ts`, `integrations/codex-login.ts`, `auth.ts` | Codex OAuth and Anthropic API key storage, Codex login, and `tesota auth` |
| `review-evaluation.ts`, `live-review.ts`, `delegation-evaluation.ts`, `live-delegation.ts` | The evaluations with known truth and their live runners |

## Current limits

- Exercised live only on Windows.
- Changes to symbolic links and submodules cannot be applied.
- Without a sandbox, approved commands run on the host without isolation.
- At most two sessions work at once; model rate-limit errors are not retried.
- The complete loop with review and correction has run on throwaway and
  evaluation repositories, not yet in daily use on a real project.
