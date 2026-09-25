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

Observed on 2026-09-26 with a running shell sandbox (`sbx` v0.45.1, Windows 11
build 26200, global policy `deny-all`):

- A Windows workspace path appears inside the VM in Git Bash form
  (`C:\Users\...` becomes `/c/Users/...`), and `exec` starts there. Only the
  mounted folder is visible: reading or writing its parent failed, and
  `~/.tesota` did not exist inside.
- Ending the `sbx exec` client does not stop the command or its children
  inside the sandbox, as with `docker exec`. The provider must stop them
  itself and confirm they are gone.
- Local use requires signing in to a Docker account, and the daemon must be
  running when the operator signs in; `sbx daemon start` runs in the
  foreground.
- Outbound requests to the npm registry and to example.com were refused with
  `403` by the proxy, and DNS resolved nothing.
- Secret-like variables inside (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GH_TOKEN` and others) held sandbox-generated placeholders that matched no
  host value.
- Writing 2,000 small files took 840 ms on the mounted workspace against 63 ms
  on the VM's own disk, and reading them 905 ms against 40 ms. Each `exec`
  adds about 0.6 s. Creating the first sandbox took 40 s, including the image
  download. An idle sandbox stops and `exec` starts it again.
- The shell sandbox has its own toolchain: Node 22.22.1, npm 9.2.0, Git 2.53
  and Python 3.14, and no Bun. The host had Node 24.15.0 and Bun 1.4.2, so a
  repository's own check commands can fail inside for toolchain reasons alone.

Sandboxes are prepared before the agent starts, following the setup phase of
Copilot, Codex and Claude Code cloud environments: pinned runtimes through
mise, then `.tesota/setup.sh` or the lockfile install. Toolchain download hosts
are allowed only during that phase and removed before the agent runs; the
provider confirms their removal from the sandbox's rule list, or deletes the
sandbox. On 2026-09-26 this prepared Tesota's own repository (Node 24.15.0,
Bun 1.4.2, `bun install --frozen-lockfile`) in 69 s, `bun run typecheck`
passed inside, a second preparation was skipped in 2 s, and nodejs.org was
refused afterward.

Prepared toolchains are reused across sessions, as Codex, Claude Code and
Cursor cache their environments. The provider writes a Sandbox Kit Spec v3
workload kit whose build stage installs the pinned runtimes with the
hash-checked mise onto Docker's shell template; `sbx` builds a local kit once
and reuses it while its content is unchanged, and the kit directory is named
by that content. Build-phase kit arguments are baked into the kit, so the
runtime versions are the arguments' defaults. The kit also declares a 20 GB
volume on the sandbox's own disk and a root startup hook that bind-mounts it
over the workspace's `node_modules` whenever the repository root has a
`package.json`, because dependency installs through the workspace mount took
about 60 s against 3 s on the sandbox's disk. The in-sandbox path arrives as
a create-phase environment argument, never spliced into the command, and the
host checkout keeps an empty `node_modules`. On 2026-09-26 each new session
on Tesota's repository was prepared in 31 s, down from 116 s for the first
and 70 s for later ones, and `bun run typecheck` passed inside in 2 s.

The sandbox's `agent` user can use `sudo` without a password and root holds
full capabilities inside the VM. That does not widen the boundary: root can
change only the VM's own filesystem, and the live suite confirms root cannot
read or write the host outside the workspace or pass the network allowlist.

The provider stops a command by tagging it with a unique environment variable,
killing every process that carries it, and confirming none remain; otherwise
the outcome is `unconfirmed`. The opt-in suite
`tests/docker-sandboxes.live.test.ts` (`TESOTA_LIVE_SANDBOX=1`) reruns the
workspace, network, variable, cancellation and timeout controls, as the
`agent` user and as root, and the dependency volume; it passed on 2026-09-26.

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
