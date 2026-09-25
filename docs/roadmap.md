# Roadmap

This page owns product status and priority.
[Decision 013](decisions/013-general-agent-loop-first.md) puts a usable general
coding loop first; [decision 014](decisions/014-execution-and-autonomy.md) sets
how commands run and how sessions become autonomous and remote.

## Status

Tesota is pre-release. The terminal shell runs a Pi coding agent in a
separate workspace per session. The agent's file tools stay inside the
workspace. Shell commands and checks run through a provider-neutral execution
environment; only the `host` provider exists, so every shell command needs
approval. When a request leaves changes, Tesota runs the approved checks on
that exact content and shows the diff. The operator applies, rejects or keeps
working. Application writes only files that still match what the workspace
started from.

On 2026-09-24, one live run fixed a bug and added a test file in about 17
seconds; the check passed and both files were applied (see
[findings](findings.md)). Day-to-day use on Tesota itself has not started yet.

## Next

The order follows decision 014's delivery plan. Remote access waits until the
local agent flow is dependable.

### 1. General agent flow for daily use

Use Tesota for its own changes on Windows and fix what gets in the way:

- The workspace starts from committed HEAD, so uncommitted work is invisible
  to the agent.
- Repositories with symbolic links or submodules are refused.
- Old workspaces are never cleaned up.
- Approved checks are chosen per session instead of per repository.

**Done when:** a normal week of Tesota's own changes goes through Tesota.

### 2. Isolated environments and autonomous sessions

Add the first isolated provider (Docker Sandboxes), qualify its guarantees
with the isolation controls, and enable autonomous sessions, pending
decisions, a default package-registry allowlist and a guided `tesota setup`.
Supervised mode keeps working with no setup.

### 3. Daemon and remote access

Move sessions into a background daemon with terminal clients, then reach it
over SSH through a private network such as Tailscale. A web and mobile client
may follow inside that network.

### Later

A non-TypeScript repository and another platform; more providers (WSL2,
native Windows candidates, remote machines) once they pass the same controls; a review queue and notifications across sessions;
non-code tasks; independent AI reviewers and user-supplied verification
methods, chosen by observed need.

## Rules

- Keep the user's request visible; an agent cannot quietly weaken it to make a
  check pass.
- Missing checks, timeouts and unconfirmed effects are never reported as
  success.
- Keep command approval, check evidence, acceptance and application separate.
- Keep one owner per behavior and add abstractions only for real consumers.
- There are no external consumers. Remove obsolete code instead of keeping
  compatibility layers.
