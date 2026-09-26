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
correction loop, at most two rounds, stopping when a round changes nothing;
and the verifier contract, where each result states its claim and limits, with
Oxlint on introduced diagnostics and LemmaScript with Dafny as the first
verifiers beyond approved checks; and ClaimCheck's method as a second
reviewer of proved contracts. Gentle AI's review waits for a contract that
admits hosts other than gentle-pi. Each workspace keeps an append-only
assurance journal of every reviewed candidate and the operator's decision.
Workflow profiles wait until daily use shows a repository that needs a
different set of verifiers, reviewers or rounds.

[Decision 016](decisions/016-review-precision.md): findings carry their origin
and face a refuter before they act, and `bun run live:review` measures review
on an evaluation set with known truth; correction rounds validate each fix and
review only their own diff; and depth computed from facts about the candidate,
with focused lenses on deep reviews, whose repeated findings are grouped by
location and merged within a file.

[Decision 018](decisions/018-verified-origin-and-review-forecast.md): Tesota
checks each finding's origin against the candidate's diff and leaves an
unsupported one to the operator as unknown, reviewers read numbered diff
lines, and a deep review first says what it will run and what comparable
reviews of the repository cost.

**Done when:** a change to Tesota goes through verification, an independent
review and a correction round, and the operator decides on the whole record.

### Exploration: Gentle AI's review as a further reviewer

Stopped on 2026-09-25 before any code, with the result in the
[review landscape](references/agent-review-landscape.md#spike-result-2026-09-25):
admitting a `tesota` host takes about seven small Go changes, but RDD is a
complete assurance transaction, with consent, its own refuter, correction,
validation and authority, not a reviewer that returns findings, and its lenses
run only inside it. Integrating it would nest a second assurance loop inside
Tesota's. Worth revisiting only if Gentle AI offers a findings-only review
entry point; its ideas are already adopted in decision 016.

### 4. Session service and remote access

[Decision 017](decisions/017-session-service-and-remote-access.md): one
session service per operator account owns every session, and terminals attach
to it over JSON-RPC on a named pipe or Unix socket, with no network port.
Questions to the operator are session state, answerable from any client. On
Windows the service starts from a Scheduled Task so it survives SSH, and the
operator reaches the PC with Windows OpenSSH Server over Tailscale. Building
it waits for section 1; web and mobile clients come after SSH access is in use.

**Done when:** over SSH from another device on the tailnet, the operator
attaches to running sessions, answers a pending question, disconnects
mid-work, and finds the work finished on reconnecting.

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
