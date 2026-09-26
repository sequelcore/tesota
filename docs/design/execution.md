# Execution

Every command a session runs, the agent's shell commands and the approved
checks, goes through an **execution environment**. The environment decides
what a command can reach; the session's **mode** decides whether it runs
without asking. Evidence for the choices below is in the
[execution landscape](../research/agent-execution-landscape.md).

## The interface

The interface is Tesota's and names no vendor: **prepare** an environment for
one workspace, **run** a command with a working directory, environment
variables, a time limit and cancellation, streaming its output and reporting
how it ended (exited, timed out, cancelled, or could not start), and
**dispose** of it. Pi's shell tool reaches it through an adapter that drops the
host environment variables Pi would otherwise pass along.

Each provider declares its guarantees in neutral terms, and every check result
records the provider and those guarantees:

| Guarantee | Values |
| --- | --- |
| Filesystem | `host` (everything the operator can reach) or `workspace` (only the session's workspace) |
| Network | `open` or `allowlist` (enforced outside the process) |
| Secrets | `none` or `placeholder` (real values injected outside the boundary) |
| Resources | `unbounded` or `bounded` (CPU and memory limits) |

A provider declares only the guarantees it passes under test: from inside it,
reads and writes outside the workspace, reads of host credentials, unapproved
network destinations, and stopping a running child process. There is no
silent fallback to a weaker provider.

## Providers

| Provider | Guarantees |
| --- | --- |
| `host` | host filesystem, open network, no secrets, unbounded |
| `docker-sandboxes` | workspace filesystem, allowlist network, no secrets, bounded |

The `docker-sandboxes` provider runs each workspace's commands in a Docker
Sandboxes microVM that mounts only the workspace, sends egress through a
deny-all proxy that allows only package registries, and caps CPU and memory.
A command that is cancelled or times out is stopped inside the sandbox by an
environment variable that tags its processes, and confirmed gone; otherwise
it is reported as unconfirmed. The sandbox's `agent` user can use `sudo` and
root holds full capabilities inside the VM, which does not widen the boundary:
the opt-in live suite (`TESOTA_LIVE_SANDBOX=1`) checks that neither the
`agent` user nor root can reach the host outside the workspace or pass the
network allowlist. The sandbox is created per workspace and removed when the
session closes or the workspace is pruned.

Every check runs with a 15-minute limit, and only the end of its output is
kept.

## Modes

| Mode | Commands | Requires |
| --- | --- | --- |
| **Supervised** | Each command asks: yes, always for this session, or no | Nothing |
| **Autonomous** | Run without asking | `workspace` filesystem and `allowlist` network |

A session is autonomous when a provider with those guarantees is ready, and
supervised otherwise. Supervised mode works on any machine with no setup; an
approved command runs with the operator's permissions, files, network and
credentials. `tesota setup` guides autonomous mode on Windows 11: the Windows
Hypervisor Platform, Docker Sandboxes, a Docker sign-in and a deny-all network
policy. It shows each missing step and its command, runs it when the operator
confirms, and stops at a restart or a failure; without a terminal to ask in,
it only lists what is missing.

## Network

When an agent command is refused a destination, the sandbox's proxy log names
it as an exact `host:port`, and after the command the operator is asked
whether to allow it for the session, for the repository, or not at all. The
agent is told the answer and whether to rerun the command. Repository choices
are stored with the approved checks and applied to each new sandbox.
Destinations always come from the proxy's log, never from the agent.

The agent loop runs on the host and calls the model from there, so the model
login never enters an environment. Workspaces hold no untracked files such as
`.env`, and environments receive no Git push credentials: applying a result
is a host operation after review.

## Preparing a sandbox

Preparation starts when a session opens, so it usually finishes while the
operator types; the first request waits for it otherwise. Tesota reads the
runtimes the repository pins (`package.json` `packageManager` and `engines`,
`.nvmrc`, `.node-version`, `.bun-version`, `.python-version`) and installs
them with mise, whose pinned binary is checked against a known SHA-256; mise
also installs what `mise.toml` or `.tool-versions` declare. Then it runs
`.tesota/setup.sh` if the repository has one, or otherwise the lockfile
install (`bun install --frozen-lockfile` or `npm ci`).

Only during this phase may the sandbox also reach the hosts toolchains
download from; Tesota removes those rules and reads the sandbox's rule list
back before the agent runs, and deletes the sandbox if it cannot confirm they
are gone. The pinned runtimes are baked into a sandbox kit that `sbx` builds
once per set of versions and reuses for later sessions, and a JavaScript
repository's `node_modules` lives on a volume on the sandbox's own disk
rather than the slower workspace mount. A failed step stops setup but not the
session, and the operator and agent are told what failed; a fingerprint of the
setup inputs skips setup when nothing changed.

## Why

- **Approval and isolation are separate settings**, as in Codex and Claude
  Code; per-command approval alone defeats unattended and parallel work.
- **The agent loop and its credentials stay outside the boundary; commands
  go inside**, as in Codex's exec server and OpenHands.
- **Pluggable environments**, as every surveyed harness that isolates keeps
  them; vendor names stay inside provider adapters.
- **A microVM rather than a native Windows sandbox:** in September 2026 the
  only mature native option was Codex's, needing elevated setup, dedicated
  identities, ACLs and firewall rules; Claude Code's sandbox does not run on
  native Windows. A microVM costs about 30 seconds per session, hidden by
  preparing at session open.
- **Supervised by default:** requiring isolation before first use would add
  friction to work supervised mode already covers.

## Planned

- Placeholder secrets: a repository declares a secret by name and host, and
  the sandbox sees only a placeholder that the proxy replaces.
- More providers behind the same interface once they pass the same controls:
  WSL2 with bubblewrap, a native Windows sandbox, remote machines.
- A configurable number of concurrent sessions, and retrying model rate-limit
  errors instead of failing a session.
