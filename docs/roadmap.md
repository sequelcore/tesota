# Roadmap

This page owns product status and priority. The [design](design/overview.md)
describes how each built capability works, and the [decisions](decisions.md)
record why.

## Status

Tesota is pre-release. A terminal shell runs a Pi coding agent in a separate
workspace per session. Commands run in a Docker Sandboxes microVM without
asking when it is set up, and with the operator's approval on the host
otherwise. Each result is checked by the operator's commands, Oxlint and
LemmaScript on the exact tree, reviewed by read-only reviewers whose findings
face a refuter and an origin check, and corrected by the agent at most twice
before the operator applies, rejects or keeps working. Each role can use its
own model, through the operator's ChatGPT plan, an Anthropic API key or the
operator's own Claude Code, and the agent can ask read-only explorers, off by
default.

The complete loop has run on throwaway and evaluation repositories; daily use
on a real project has not started.

## Built

| Capability | Built | Design |
| --- | --- | --- |
| Workspaces with uncommitted changes, updates from the source, guarded application, pruning | 2026-09-25 | [Workspace](design/workspace.md) |
| Execution environments, Docker Sandboxes, autonomous and supervised modes, network questions, sandbox preparation and `tesota setup` | 2026-09-25 | [Execution](design/execution.md) |
| Request record, flags, verifiers with claims, reviewer and lenses, ClaimCheck, refuter, origin check, correction loop with fix validation, assurance journal, forecast, `live:review` | 2026-09-25 | [Assurance](design/assurance.md) |
| Explorers, models by role, `tesota models`, `live:delegation` | 2026-09-25 | [Agents](design/agents.md) |
| Claude through an Anthropic API key or the operator's Claude Code | 2026-09-25 | [Agents](design/agents.md#model-routes) |

## Next

### 1. Features before daily use

The operator is adding further Tesota features before using it on a real
project. They are listed here as they are chosen.

### 2. Daily use on a real project

Use Tesota on SIACODE, then on Tesota's own changes, and fix what gets in the
way. Explorers are revisited with evidence from long sessions, and reviewer
and refuter models with the harder cases real work produces.

**Done when:** a normal week of real changes goes through Tesota, with
verification, review, a correction round and the operator's decision on the
whole record.

### 3. Session service and remote access

The [session service](design/sessions.md#planned-a-session-service): sessions
outlive the terminal, and the operator reaches them over SSH on a tailnet.
Building it waits for step 2.

**Done when:** over SSH from another device on the tailnet, the operator
attaches to running sessions, answers a pending question, disconnects
mid-work, and finds the work finished on reconnecting.

## Later

- Read `.devcontainer/devcontainer.json` as a toolchain definition, so
  repositories that already describe their environment need nothing
  Tesota-specific.
- A non-TypeScript repository and another platform.
- More execution providers once they pass the same live controls: WSL2,
  remote machines, a native Windows sandbox.
- A review queue and notifications across sessions.
- Non-code tasks, and user-supplied verifiers and reviewers, by observed need.
- Workflow profiles that choose verifiers, reviewers and rounds per
  repository, once two real alternatives exist.
- A Java backend in the monorepo of a first user will need Java checks in the
  sandbox, per-part checks and nested instructions.

## Stopped

- **Gentle AI's review as a further reviewer**, 2026-09-25, before any code:
  its RDD is a complete assurance transaction, with its own consent, refuter,
  correction and authority, rather than a reviewer that returns findings, so
  integrating it would nest a second assurance loop inside Tesota's. Its ideas
  are adopted in the [assurance design](design/assurance.md). Details are in
  the [review landscape](research/agent-review-landscape.md#spike-result-2026-09-25).
