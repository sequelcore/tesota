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

The order follows decision 014's delivery plan, with decision 015's
verification and review before remote access. Remote access waits until the
local agent flow is dependable.

### 1. General agent flow for daily use

Use Tesota for its own changes on Windows and fix what gets in the way.
Done on 2026-09-25: workspaces include uncommitted changes, repositories with
symbolic links and submodules open, approved checks are remembered per
repository, `tesota prune` removes unused workspaces, `Ctrl+W` closes a
session and removes its workspace, and each request first brings in newer
source edits, carrying pending work onto them.

**Done when:** a normal week of Tesota's own changes goes through Tesota.

### 2. Isolated environments and autonomous sessions

Done on 2026-09-25: the Docker Sandboxes provider, qualified by the live
isolation controls; autonomous sessions when it is ready and supervised ones
otherwise; a default package-registry allowlist; `tesota setup`; and sandbox
preparation from the repository's pinned runtimes, `.tesota/setup.sh` and
lockfile, with download hosts open only during setup; the pinned runtimes
cached as a sandbox kit reused across sessions, with `node_modules` on the
sandbox's own disk; refused network destinations become a question the
operator answers for the session or the repository; `tesota setup` runs the
missing steps once the operator confirms each; and preparation starts when a
session opens.

### 3. Verification and review around each result

[Decision 015](decisions/015-assurance-around-the-agent-loop.md): Tesota
verifies and reviews each candidate before the operator decides, and sends
fixable problems back to the agent a bounded number of times. In order: the
request record and flagged changes to tests and check configuration; an
independent read-only reviewer; the correction loop; the verifier contract
with Oxlint and LemmaScript with Dafny; ClaimCheck's method and Gentle AI's
review as further reviewers; per-repository workflow profiles.

Done on 2026-09-25: the request record, kept beside the checkout and started
over whenever nothing is pending, and ⚠ flags on changes to tests, check
configuration, CI, formal specifications, package scripts and Tesota setup;
and Tesota's reviewer, a fresh read-only Pi session that reports structured
findings, qualified on seeded defects (see [findings](findings.md)); and the
correction loop, at most two rounds, stopping when a round changes nothing.

**Done when:** a change to Tesota goes through verification, an independent
review and a correction round, and the operator decides on the whole record.

### 4. Daemon and remote access

Move sessions into a background daemon with terminal clients, then reach it
over SSH through a private network such as Tailscale. A web and mobile client
may follow inside that network.

### Later

Read `.devcontainer/devcontainer.json` (the open Dev Containers
specification) as a toolchain definition: its image or Dockerfile, Features
and lifecycle commands, so repositories that already describe their
environment need nothing Tesota-specific.


A non-TypeScript repository and another platform; more providers (WSL2,
remote machines, and a native Windows OS sandbox for faster supervised or
autonomous sessions, possibly built as its own project with Tesota) once they
pass the same live controls; a review queue and notifications across sessions;
non-code tasks; user-supplied verifiers and reviewers beyond the workflow
profiles of section 3, chosen by observed need.

## Rules

- Keep the user's request visible; an agent cannot quietly weaken it to make a
  check pass.
- Missing checks, timeouts and unconfirmed effects are never reported as
  success.
- Keep command approval, check evidence, acceptance and application separate.
- Keep one owner per behavior and add abstractions only for real consumers.
- There are no external consumers. Remove obsolete code instead of keeping
  compatibility layers.
