# Architecture

**Tesota is an open-source agent for work that carries its evidence.** You
describe what you need, a coding agent does it in a separate copy of your
repository, and you review the exact changes and what the checks establish
before anything reaches your files. The long-term goal is a general-purpose
harness; [decision 013](decisions/013-general-agent-loop-first.md) puts a
usable coding loop first. The [roadmap](roadmap.md) tracks what comes next.

The name comes from *Olneya tesota*, the Sonoran Desert ironwood tree. It is
not a dependability claim. Trademark clearance has not been done.

## Principles

1. A check states what it observed, about which exact content, under which
   conditions.
2. Evidence for earlier content does not carry over after the content changes.
3. Failures, timeouts, cancellations and unconfirmed effects stay distinct.
   None of them becomes a pass.
4. Checks, human acceptance and application are separate facts.
5. Model output and check results never grant authority. The operator
   approves commands and applies changes.

## Components

Tesota owns the workspace, command approval, checks, review and application.
Pi (`@earendil-works/pi-*`) is the agent engine and terminal UI toolkit.
Codex, through Pi's OAuth support, is the only model route (see
[authentication](authentication.md)). Replacing the engine or model needs the
affected behavior re-exercised; there is no engine registry.

## Flow

```text
request
  -> CodingSession        Pi agent in the workspace checkout
                          file tools confined to the checkout; each shell command approved
  -> Workspace.snapshot   all work staged: changed paths, diff and Git tree id
  -> runChecks            approved commands run on that tree; a check that edits files is flagged
  -> review               diff and check output in the result panel
  -> apply | reject | keep working
       apply:  applyWorkspace writes only files whose source still matches the base,
               then the workspace records the applied tree as its new base
       reject: the workspace returns to its base
```

Each shell session owns one workspace: an independent clone of the source's
committed HEAD under `~/.tesota/workspaces/`, without the source's remotes,
hooks or config. The source's uncommitted, non-ignored changes are captured
through a private index and object directory kept in the workspace, so nothing
is written to the source repository, and added to the workspace as one commit;
that commit is the base, so later diffs show only the agent's work.

Before each request the workspace takes the source's newer state the way Git
rebases: the captured source becomes the new base, and pending work is carried
onto it with a three-way cherry-pick. If pending work conflicts with the newer
source, nothing changes and the operator is told which files. The agent is
told which files changed. The private index keeps Git's stat cache, so a check
that finds nothing new is cheap. Line endings are read as
the operator's `core.autocrlf` setting shows them. Symbolic links are checked
out as plain files holding the link text (`core.symlinks=false`) and
submodules stay uninitialized; application refuses changes to either. The agent keeps its conversation across
requests, so "keep working" builds on pending changes. Up to two sessions work
at once; applications are serialized.

## Owners

| Owner | Responsibility |
| --- | --- |
| `cli.ts` | Commands and shell startup |
| `tesota-shell.ts` | Surface-independent loop: request, review, decision |
| `tesota-shell-command.ts` | Per-session composition of workspace, agent, checks and application |
| `tesota-shell-terminal.ts`, `tesota-shell-theme.ts`, `tesota-shell-inspection.ts`, `shell-progress.ts` | Terminal layout, themes, result panel and status |
| `shell-session-store.ts` | Saved transcripts, workspace location and approved checks per session |
| `integrations/pi-coding-session.ts` | Pi session, confined file tools, command approval, cancellation |
| `workspace-checkout.ts` | Creating, verifying and listing independent clones |
| `source-snapshot.ts` | Capturing the source's uncommitted changes without writing to it |
| `workspace-prune.ts` | Deciding which workspaces `tesota prune` may remove |
| `workspace.ts` | Base commit, snapshots, revert and settling applied work |
| `execution-environment.ts` | Provider-neutral interface for where commands run, and the guarantees a provider declares |
| `host-environment.ts` | The `host` provider: commands run directly on this machine |
| `docker-sandboxes-environment.ts` | The `docker-sandboxes` provider: readiness, sandbox lifecycle, setup network phase, allowlist and confirmed stops |
| `toolchain.ts` | Reading a repository's pinned runtimes, setup script and dependency install, and the pinned mise installer |
| `execution-providers.ts` | Choosing a session's mode and provider, `tesota setup`, and releasing provider resources |
| `workspace-checks.ts` | Check suggestions and running approved checks in the session's environment |
| `workspace-apply.ts` | Conflict-checked writes to the source repository and their journal |
| `repository-git.ts` | Git invocation without ambient config, hooks or network |
| `integrations/codex-credentials.ts`, `auth.ts` | Codex login storage |
| `verification/` | Standalone Oxlint profile and the formal invocation-budget predicate |
| `live-codex.ts`, `integrations/pi-live*.ts` | Live Codex probe and model route |

## Execution environments

Every command a session runs, the agent's shell commands and its checks, goes
through an execution environment ([decision 014](decisions/014-execution-and-autonomy.md)).
The interface names no vendor. A provider declares what it enforces for
filesystem (`host` or `workspace`), network (`open` or `allowlist`), secrets
(`none` or `placeholder`) and resources (`unbounded` or `bounded`); each check
result records the provider and those guarantees. Pi's shell tool reaches the
environment through an adapter that drops the host environment variables Pi
would otherwise pass along.

Two providers exist. `host` isolates nothing, so a session using it is
supervised: every shell command needs approval. `docker-sandboxes` runs each
workspace's commands in a Docker Sandboxes microVM that mounts only the
workspace, sends egress through a deny-all proxy that allows only package
registries, and caps CPU and memory. When it is ready, sessions are
autonomous: commands run without asking, and the agent is told what it can
reach. `tesota setup` reports what is missing otherwise. The sandbox is
created per workspace and removed when the session closes or the workspace is
pruned.

Before the agent starts, the sandbox is prepared for the repository, as
Copilot's setup steps and Codex and Claude Code cloud environments do. Tesota
reads the runtimes the repository pins (`package.json` `packageManager` and
`engines`, `.nvmrc`, `.node-version`, `.bun-version`, `.python-version`) and
installs them with mise, whose pinned binary is checked against a known
SHA-256; mise also installs what `mise.toml` or `.tool-versions` declare. Then
it runs `.tesota/setup.sh` if the repository has one, or otherwise the
lockfile install (`bun install --frozen-lockfile` or `npm ci`). Only during
this phase may the sandbox also reach the hosts toolchains download from,
such as nodejs.org and GitHub release assets; Tesota removes those rules and
reads the sandbox's rule list back before the agent runs, and deletes the
sandbox if it cannot confirm they are gone. A failed step stops setup but not
the session, and the operator and agent are told what failed. A fingerprint of
the setup inputs skips setup when nothing changed. A command that is cancelled or times out is stopped inside the
sandbox and confirmed gone; otherwise it is reported as unconfirmed.

## Trust and effects

Repository content and model output are untrusted. The file tools (read,
grep, find, ls, edit, write) resolve every path against the checkout and
refuse anything outside it, including through links; edit and write also
refuse `.git`. In the `host` environment shell commands are not confined:
each needs the operator's approval ("always" lasts for the session), and an
approved command runs with the operator's permissions, files, network and
credentials. Repository
instructions in `AGENTS.md` or `CLAUDE.md` are passed to the agent as context.

Application writes exactly the reviewed tree. For each changed file, the
source must still hold the base content (a CRLF checkout of that content
counts as unchanged, and keeps its line endings); an added file must not
exist yet. If any file conflicts, nothing is written. Writes are journaled in
the workspace's `applications.jsonl`; a failure after the first write is
reported as uncertain and closes the session.

## Checks

The operator approves check commands once per session. Tesota suggests the
repository's `check` script, or its `typecheck`, `lint` and `test` scripts,
using the lockfile's package manager; `cargo test` and `go test ./...` are
suggested for Rust and Go. Checks run in the session's execution environment,
with a 15-minute limit each; only the end of their output is kept. A result is
bound to the tree it ran on. A check that changes files is reported as
`changed_files`, and the review content no longer matches, so application is
refused until the work is reviewed again.

`tesota verify <file>` runs the fixed Oxlint profile on one file.
`bun run formal:check` proves the invocation-budget predicate with
LemmaScript and Dafny.

## Current limits

- Exercised live only on Windows. Changes to symbolic links and submodules
  cannot be applied.
- Supervised sessions run approved commands on the host without isolation.
- Only runtimes pinned in the files above, `mise.toml` or `.tool-versions` are
  installed; anything else needs `.tesota/setup.sh`. Dev Container
  definitions are not read yet.
- Newer source edits that conflict with pending work wait until that work is
  applied or rejected.
- Closing a session (`Ctrl+W`) removes its record, transcript and workspace;
  a session with unresolved effects keeps its workspace as evidence.
  `tesota prune` removes other unused workspaces.
