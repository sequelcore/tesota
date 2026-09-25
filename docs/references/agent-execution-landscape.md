# Agent execution landscape (September 2026)

How coding-agent harnesses isolate command execution, control network and
credentials, run unattended, and support remote clients. Researched on
2026-09-24 and 2026-09-25 from vendor documentation, the source of projects
cloned under `Sequel/cloned` (Codex at `32329b28`, 2026-07-24), and one
source-code study. It informs
[decision 014](../decisions/014-execution-and-autonomy.md). Product behavior
changes quickly; recheck a claim before relying on it.

## What each system does

| System | Isolation of commands | Network | Credentials | Unattended and remote |
| --- | --- | --- | --- | --- |
| Codex CLI | Native sandbox on macOS, Linux and Windows. Sandbox policy `read-only`, `workspace-write` (extra writable roots, network flag), `danger-full-access`, or `external-sandbox` when already inside one. The Windows sandbox needs an elevated setup and uses sandbox identities, ACLs, Windows Firewall rules and a network proxy. | Off by default in the sandbox policies; per-policy flag. | Model login stays in the Codex process. | Approval policy is separate from sandbox policy: `untrusted`, `on-request`, `granular`, `never`. `app-server` exposes the agent over JSON-RPC (stdio, unix socket, experimental WebSocket); `exec-server` runs processes separately and can register as a remote environment. |
| Claude Code Remote Control | Not an isolation feature: the session keeps running on the user's machine. | Unchanged. | Unchanged. | Web and mobile clients drive a local session. The local process "makes outbound HTTPS requests only and never opens inbound ports"; Anthropic's service relays messages. |
| Claude Code | Bash sandbox (Seatbelt on macOS, bubblewrap on Linux and WSL2). **Native Windows is not supported**; use WSL2, a container or a VM. The whole process can run inside Sandbox Runtime (SRT). | Host proxy with a domain allowlist. | Credential files can be denied, or masked: commands see a placeholder and the proxy injects the real value only for listed hosts. | Docs require a container, VM or SRT for `--dangerously-skip-permissions`; the per-command Bash sandbox alone is "not sufficient for fully unattended runs". Cloud sessions run in managed VMs with an allowlisting proxy and a Git proxy that keeps the GitHub token outside the sandbox. |
| Docker Sandboxes (`sbx`) | A microVM per sandbox with its own kernel and Docker daemon. Runs on Windows 11 through the Windows Hypervisor Platform; Docker Desktop is not required. Local use is free; cloud sandboxes are paid. | All outbound TCP goes through a host proxy; unapproved destinations are denied by default. | Placeholder credentials inside; the host proxy substitutes the real value after the request leaves the VM. | Ten named agents plus an agent-less shell sandbox. Workspaces can be mounted directly, cloned from a read-only mount, or kept inside. The Sandbox Kit Spec (Apache-2.0, published 2026-09-24, proposed to CNCF) packages an agent's network rules, credentials and volumes as an OCI image and supports custom agents. |
| GitHub Copilot cloud agent | Ephemeral GitHub Actions runner per task. | Firewall with a recommended allowlist of package and container registries. It applies only to processes started by the agent's Bash tool, not to MCP servers or setup steps. | Held by the GitHub platform. | Fully remote and asynchronous; results come back as pull requests. |
| OpenHands | Agent loop in the backend; actions run through a REST "action executor" inside a Docker container built from a user image. | Container networking. | Kept in the backend. | Local, Docker and remote runtimes behind the same interface. |
| Pi | None. "Pi does not include a built-in permission system"; it runs with the user's permissions. | None. | Stored on the host. | Recommends running inside Docker, Docker Sandboxes or OpenShell, or the Gondolin extension, which keeps Pi and its credentials on the host and routes built-in tools and commands into a Linux micro-VM. |
| hermes-agent | Pluggable terminal backends: local, Docker, SSH, Singularity, Modal, Daytona, Vercel Sandbox. | Backend-dependent. | Backend-dependent. | Dangerous-command detection with prompts, optionally auto-approved by a second model. |
| t3code | None of its own; maps its permission modes onto each provider (Codex sandbox levels, Claude permission modes). Default mode is full access; recommends disposable worktrees. | Provider-dependent. | Provider-dependent. | Server with thin desktop, web and mobile clients; background service; one-time pairing tokens; recommends Tailscale. The hosted relay only links environments and sends notifications and is "not in the hot path". |
| gentle-pi | None; its remediation approval is explicitly "not a shell sandbox". | None. | Host. | Local. |

A source-code study of eleven harnesses (Barbaste et al., submitted
2026-07-15) found that none imports a general agent framework, and that ACP
(Agent Client Protocol) ships in six systems, including harnesses hosting other
harnesses.

## Separate working copies

When an agent works outside the user's checkout, the surveyed tools start the
copy from a chosen state and never mirror later edits automatically:

- Codex's app applies the local branch's uncommitted changes when it creates a
  worktree; later local edits are not synced, and work moves between the
  worktree and the local checkout through an explicit "Hand off"
  ([Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)).
- Claude Code worktrees branch from the default branch or `HEAD`, copy only
  gitignored files listed in `.worktreeinclude`, and do not sync with the main
  checkout ([worktrees](https://code.claude.com/docs/en/worktrees)).
- t3code gives a thread its own Git worktree (`docs/internals/glossary.md`).
- Docker Sandboxes either mounts the workspace directly, so both sides see the
  same files, or works on a private clone of a read-only mount (`--clone`).

## Repository toolchains in isolated environments

Researched on 2026-09-26. Every surveyed system prepares the environment
before the agent starts, keeps the result, and rebuilds it when its
definition changes:

| System | Where the definition lives | What runs, and when | Network during setup | Reuse |
| --- | --- | --- | --- | --- |
| GitHub Copilot cloud agent | `.github/workflows/copilot-setup-steps.yml`, job `copilot-setup-steps` | Actions steps such as `actions/setup-node` and `npm ci`, before the agent; a failed step lets the agent start anyway | "The firewall only applies to processes started by the agent via its Bash tool. It does not apply ... to processes started in configured Copilot setup steps." | Runner per task |
| Codex cloud | Environment settings | A `universal` image with pinned runtime versions (`CODEX_ENV_NODE_VERSION` and others; Node 18, 20, 22; Bun 1.2.10 included), then a setup script; a maintenance script on resumed containers | "Setup scripts run with internet access. Agent internet access is off by default." | Container state cached up to 12 hours; invalidated when scripts, variables or secrets change |
| Claude Code cloud sessions | Environment settings, plus a repository `SessionStart` hook for project dependencies | Setup script as root on Ubuntu 24.04 before Claude Code starts; Node 20 to 22 preinstalled, Bun installed but with "known proxy compatibility issues" for package fetching | The agent proxy starts after the setup script | Filesystem snapshot reused; rebuilt when the script or allowed hosts change, or after about seven days |
| Cursor cloud agents | `.cursor/environment.json`, committed | `install` when a build is created (must be idempotent), `start` when an agent boots, or a Dockerfile | Not stated | Successful builds become the starting disk; Dockerfile layers cached |
| Dev Containers (open specification) | `.devcontainer/devcontainer.json` | Image or Dockerfile, versioned Features, then `onCreateCommand`, `updateContentCommand`, `postCreateCommand`, `postStartCommand` | Not constrained by the specification | Image layers |
| Docker Sandboxes | `sbxenv.yaml` beside the workspace (experimental), kits, or a template image | Kits are OCI images built from Dockerfile stages, with install hooks run as root after all kits are combined | Kit mixins carry their tools' network rules | Kit images |

Two layers recur: the toolchain (runtimes and CLIs, provisioned once and
cached) and project dependencies (`npm ci` and similar, per session). Version
files that repositories already commit can drive the toolchain layer: mise
reads `mise.toml`, `.tool-versions` and idiomatic files such as `.nvmrc`,
`.node-version`, `.bun-version` and `package.json`, although idiomatic files
are disabled by default, and it downloads Node.js from nodejs.org by default.

Sources: [Copilot environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment),
[Copilot firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall),
[Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment.md),
[codex-universal](https://github.com/openai/codex-universal/blob/main/README.md),
[Claude Code cloud environments](https://code.claude.com/docs/en/cloud-environments),
[Cursor cloud setup](https://cursor.com/docs/cloud-agent/setup),
[devcontainer.json reference](https://containers.dev/implementors/json_reference/),
[sbxenv.yaml](https://docs.docker.com/ai/sandboxes/configuration/environment-files/),
[kit authoring patterns](https://docs.docker.com/ai/sandboxes/customize/author/patterns/),
[mise configuration](https://mise.jdx.dev/configuration.html),
[mise Node.js](https://mise.jdx.dev/lang/node.html).

## Patterns

1. **Approval and isolation are separate settings.** Codex and Claude Code both
   separate "may this run without asking" from "what can it reach once it
   runs". Removing prompts is acceptable only inside a boundary.
2. **The agent loop stays outside; execution goes inside.** Codex
   (`exec-server`), OpenHands (action executor), Pi's Gondolin extension and
   Claude Code cloud sessions keep model credentials and orchestration on the
   trusted side and send commands into the boundary.
3. **Egress goes through a host proxy with an allowlist**, and secrets are
   injected there as placeholders are replaced (Claude Code masking, Docker
   Sandboxes). The agent never holds the real secret.
4. **Remote use means a long-running server with thin clients**: t3code's
   paired clients over a private network, and Codex's app-server protocol.
5. **Native Windows sandboxing is rare and costly.** Only Codex ships one, with
   an elevated setup. Claude Code sends Windows users to WSL2, containers or
   VMs; SRT's Windows support is alpha and failed Tesota's write test (see
   [findings](../findings.md#isolation)). A hypervisor-backed microVM is the
   practical strong boundary on a Windows 11 host.

## Sources

- Codex source: `codex-rs/protocol/src/protocol.rs` (`SandboxPolicy`,
  `AskForApproval`), `codex-rs/windows-sandbox-rs/`,
  `codex-rs/app-server/README.md`, `codex-rs/exec-server/README.md`; license
  Apache-2.0.
- Claude Code: [Configure the sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing),
  [Choose a sandbox environment](https://code.claude.com/docs/en/sandbox-environments).
- Docker: [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/),
  [Install](https://docs.docker.com/ai/sandboxes/install/),
  [Architecture](https://docs.docker.com/ai/sandboxes/architecture/),
  [Agents](https://docs.docker.com/ai/sandboxes/agents/),
  [Sandbox Kit Spec](https://www.docker.com/blog/docker-sandbox-kit-spec/).
- GitHub: [Customize the agent firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall),
  [Allowlist reference](https://docs.github.com/en/copilot/reference/copilot-allowlist-reference).
- OpenHands: [Runtime architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime).
- Pi: `README.md` and `packages/coding-agent/docs/containerization.md` in the
  cloned repository.
- hermes-agent: `README.md`, `tools/environments/`, `tools/approval.py`.
- t3code: `docs/user/permission-modes.md`, `docs/user/remote-access.md`,
  `docs/user/background-service.md`, `infra/relay/README.md`.
- Barbaste, Darrigol, Vu, Wiltberger, [Harness Engineering: Anatomy,
  Architecture, and Evolution of Coding Agents](https://arxiv.org/abs/2609.00006).

- Claude Code: [Remote Control](https://code.claude.com/docs/en/remote-control).
- `sbx` v0.45.1 (released 2026-09-22): help output of `exec`, `create`,
  `create shell`, `policy init`, `policy allow network`, `secret set-custom`,
  `rm` and `login` from the Authenticode-signed Windows MSI, extracted without
  installing. No sandbox was started.

Not verified: Codex's hosted sandbox documentation (moved; the source was used
instead), Cursor's and Devin's cloud agents, and `sbx` behavior with a running
sandbox (path mapping, cancellation, sign-in requirement, file performance).
