# Roadmap

This page owns product status and priority.
[Decision 013](decisions/013-general-agent-loop-first.md) sets the direction:
a usable general coding loop first, with verification around its result.

## Status

Tesota is pre-release. The terminal shell runs a Pi coding agent in a
separate workspace per session. The agent's file tools stay inside the
workspace, and every shell command needs approval. When a request leaves
changes, Tesota runs the approved checks on that exact content and shows the
diff. The operator applies, rejects or keeps working. Application writes only
files that still match what the workspace started from.

On 2026-09-24, one live run fixed a bug and added a test file in about 17
seconds; the check passed and both files were applied (see
[findings](findings.md)). Day-to-day use on Tesota itself has not started yet.

## Next

### 1. Use it every day

Use Tesota for its own changes, on Windows, and fix what gets in the way.
Known gaps:

- The workspace starts from committed HEAD, so uncommitted work is invisible
  to the agent.
- Repositories with symbolic links or submodules are refused.
- Old workspaces are never cleaned up.
- Approved checks are chosen per session instead of per repository.

**Done when:** a normal week of Tesota's own changes goes through Tesota.

### 2. Beyond TypeScript and Windows

Exercise a non-TypeScript repository and one other platform, and fix what
breaks.

### 3. Verification and review as options

Let users choose checks and reviewers per repository, including a protected
execution route and an independent AI reviewer. A missing or failed check
never reads as a pass.

### Later

Non-code tasks, a native OS sandbox for commands (see
[decision 007](decisions/007-execution-environments.md)) and user-supplied
verification methods, chosen by observed need.

## Rules

- Keep the user's request visible; an agent cannot quietly weaken it to make a
  check pass.
- Missing checks, timeouts and unconfirmed effects are never reported as
  success.
- Keep command approval, check evidence, acceptance and application separate.
- Keep one owner per behavior and add abstractions only for real consumers.
- There are no external consumers. Remove obsolete code instead of keeping
  compatibility layers.
