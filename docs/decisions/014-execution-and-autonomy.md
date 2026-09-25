# 014: Provider-neutral execution environments and autonomy

Status: adopted 2026-09-25. Supersedes the execution direction in
[decision 007](007-execution-environments.md). Evidence is in the
[agent execution landscape](../references/agent-execution-landscape.md).

## Context

The operator mostly works remotely, connecting to a Windows 11 PC, and wants
several sessions to run on their own while doing other work. The current loop
asks before every shell command, so an unattended session stalls on its first
`bun install`; and an approved command runs with the operator's full
permissions, files, network and credentials.

Official documentation and the source of the cloned harnesses converge on a
small set of practices (see the landscape page):

1. **Approval and isolation are separate settings.** Codex pairs a sandbox
   policy with an approval policy; Claude Code pairs permission modes with a
   sandbox, and requires a container, VM or its sandbox runtime before prompts
   are removed entirely.
2. **The agent loop and its credentials stay outside the boundary; commands go
   inside.** Codex `exec-server`, OpenHands' action executor, Pi's Gondolin
   extension and Claude Code cloud sessions all do this.
3. **Egress goes through a host proxy with an allowlist, and secrets are
   placeholders replaced at the proxy** (Claude Code credential masking,
   Docker Sandboxes).
4. **Execution environments are pluggable.** OpenHands (local, Docker,
   remote), hermes-agent (seven backends), Pi (Docker, micro-VM, OpenShell) and
   Claude Code (Bash sandbox, container, VM, cloud) treat the boundary as a
   choice, not a fixed dependency.
5. **Real isolation on Windows costs a one-time elevated step** in every
   option: Codex's sandbox setup, SRT's `windows-install`, WSL2, Docker
   Desktop, or the Windows Hypervisor Platform for Docker Sandboxes. Harnesses
   that ask for nothing (Pi, OpenCode, t3code's default) isolate nothing.

## Decision

### 1. One provider-neutral execution interface

Every command Tesota runs for a session, whether the agent's shell command or
a check, goes through an **execution environment**. The interface is Tesota's
and names no vendor:

- **prepare** an environment for one workspace and a policy;
- **run** a command with a working directory, environment variables, a time
  limit and cancellation, streaming its output and reporting how it ended
  (exited with a code, timed out, cancelled, or could not start);
- **dispose** of it.

Each provider declares its **guarantees** in the same neutral terms:

| Guarantee | Values |
| --- | --- |
| Filesystem | `host` (everything the operator can reach) or `workspace` (only the session's workspace) |
| Network | `open` or `allowlist` (enforced outside the process) |
| Secrets | `none` or `placeholder` (real values injected outside the boundary) |
| Resources | `unbounded` or `bounded` (CPU and memory limits) |

Tesota selects a provider by the guarantees a mode requires, never by name,
and records the provider and its guarantees with every check result. If no
available provider meets a mode's requirements, that mode does not start;
there is no silent fallback to a weaker provider.

Providers are adapters behind this interface:

| Provider | Guarantees | Status |
| --- | --- | --- |
| `host` | host filesystem, open network, no secrets, unbounded | Implemented first |
| Docker Sandboxes (`sbx`) | workspace, allowlist, placeholder, bounded | First isolated provider |
| WSL2 with bubblewrap | workspace, allowlist | Candidate for users who already have WSL2 |
| Codex Windows sandbox, SRT | to be measured | Candidates once they pass the same controls |
| Remote or cloud machines | per provider | Later |

A provider is qualified before Tesota relies on its guarantees: from inside
it, attempt reads and writes outside the workspace, reads of host
credentials, unapproved network destinations, and cancellation of a running
child process. Only guarantees that pass are declared.

### 2. Autonomy is a policy, separate from the environment

| Mode | Commands | Required guarantees |
| --- | --- | --- |
| **Supervised** | Ask each time, or "always" for the session | None |
| **Autonomous** | Run without asking | `workspace` filesystem and `allowlist` network |

A session is autonomous when an environment meeting those guarantees is
available, and supervised otherwise. Supervised mode works on any machine
with no setup. Autonomous mode needs a one-time setup that Tesota guides
(`tesota setup`): it detects what is missing, explains why, and runs the
elevated step through the normal Windows elevation prompt. Tesota never
performs that step without the operator starting it.

An autonomous session stops only for what its policy does not cover: a
network destination outside the allowlist, a secret that is not configured,
and the final apply-or-reject decision. These become pending decisions that
wait without blocking other sessions.

### 3. Network and credentials stay on the host

- In an `allowlist` environment, the default allowlist covers package
  registries (for example npm, PyPI, crates.io and the Go module proxy).
  Repositories can extend it; any other destination is a pending decision.
- The agent loop runs on the host and calls the model from there. The model
  login never enters an environment.
- Workspaces are cloned from committed HEAD, so untracked secret files such as
  `.env` are absent. A repository that needs a secret declares it by name and
  destination host; a `placeholder` environment receives only a placeholder.
- Applying a result is a host operation after review. Environments receive no
  Git push credentials.

### 4. Review and application stay the trust gate

Nothing changes in the source repository until the operator applies a
reviewed result. Checks run in the session's environment on the exact tree,
and the review names the environment and its guarantees. Autonomous sessions
end in a review queue instead of a prompt.

### 5. Parallel sessions are scheduled

A configurable number of sessions run at once (default 3); the rest queue.
Model rate-limit errors back off and retry instead of failing a session.

### 6. Remote access comes after the general agent flow

Remote access is built only once the local agent flow is dependable. Its
design is fixed now so earlier work does not block it:

- A background daemon owns sessions, and terminals connect to it as clients,
  so work survives a dropped connection. The client API is JSON-RPC over a
  local socket, the shape used by Codex's app-server and by ACP-capable
  harnesses.
- The operator reaches the PC through a private network (for example
  Tailscale) and SSH, never a public port. A web and mobile client may follow,
  served only inside that network with one-time pairing tokens, as t3code
  does. An outbound-only relay, as in Claude Code Remote Control, is a later
  option.

Until then, session orchestration stays separate from the terminal UI, so the
daemon can host it without a rewrite.

## Delivery

1. **Execution interface with the `host` provider.** The agent's shell
   commands and checks run through it; behavior is unchanged.
2. **General agent flow for daily use:** uncommitted-change awareness,
   workspace cleanup, checks remembered per repository.
3. **Docker Sandboxes provider, qualification controls, autonomous mode,
   pending decisions and `tesota setup`.**
4. **Daemon and remote access** (SSH over a private network), then a web and
   mobile client.
5. Further providers (WSL2, native Windows candidates, remote) as they pass
   qualification.

## Verified and open

Verified on 2026-09-25 against the help of the signed `sbx` v0.45.1 Windows
build, without running a sandbox: agent-less `shell` sandboxes with a mounted
workspace; `exec` with `docker exec` semantics (environment, working
directory, user; no detached mode); per-sandbox `--cpus` and `--memory`;
`policy init deny-all` with per-sandbox `policy allow network` rules;
experimental `secret set-custom`, where the sandbox sees a placeholder and the
proxy substitutes the real value for listed hosts; and `rm --force` cleanup.

To verify with a running sandbox during delivery step 3:

- how the Windows workspace path appears inside the Linux VM;
- whether ending the `sbx exec` client stops the process inside the sandbox;
- whether local use requires signing in to a Docker account;
- file performance of the mounted workspace for `bun install` and tests.

## Consequences

- Tesota works immediately in supervised mode. Autonomous mode costs one
  guided elevated step and a restart for the Docker Sandboxes provider, the
  same class of cost as every isolating option on Windows.
- Vendor names appear only inside provider adapters, and changing or adding a
  provider does not change sessions, checks, review or application.
- Each isolated session uses disk and memory for its environment, and its
  first command is slower than on the host.
- Docker Sandboxes is proprietary, although free for local use. The
  interface keeps it replaceable; the Sandbox Kit Spec (Apache-2.0, proposed
  to CNCF) is a candidate format for describing an environment once it has
  independent implementations.

## Rejected alternatives

- **Build a native Windows sandbox.** Codex's needs an elevated setup,
  dedicated identities, ACL management and firewall rules, and SRT's alpha
  shows how hard the write boundary is. Tesota's value is not there.
- **Require isolation setup before first use.** It adds friction for work
  that supervised mode already covers.
- **Keep per-command approval as the only control.** It defeats unattended and
  parallel work.
- **Run the whole Tesota process inside the boundary.** It would put the model
  login inside and make review and remote access harder.
- **Bind Tesota to one sandbox product.** Every surveyed harness that isolates
  keeps the environment pluggable.
