# 004: Fixed-command isolation boundary

Status: adopted for the first proposed code task. This decision qualifies one
runner and one fixed diagnostic command; it does not authorize arbitrary shell
commands or connect command execution to task proposals.

## Problem

A Git candidate separates working bytes, but it does not protect the host from
repository code. General repository tasks eventually need to run builds and
checks without exposing unrelated files, credentials or network access. Giving
the whole candidate write access would also be broader than Tesota's proposed
file grant.

The first isolation boundary therefore has to enforce these capabilities
separately:

- read the candidate;
- write only the admitted existing source file;
- write build output in a distinct directory;
- write verifier scratch data in a distinct directory;
- access neither an outside sentinel nor a synthetic credential;
- make no network connection; and
- settle the command and its child when cancellation is requested.

Initialization, execution or cleanup uncertainty must not produce a passing
result.

## Research basis

The design was checked against current official documentation and the local
reference revisions below. These systems informed the boundary; Tesota does not
copy their workflow or treat their claims as evidence for Tesota.

| Reference | Revision or version | Relevant observation |
| --- | --- | --- |
| Codex | source `32329b289d05eb6a3f8e35c267ceb25ba46716a2`; installed CLI `0.154.0` | Separates sandbox permissions from approval, disables command network by default and provides native Windows enforcement. Its current native backend was suitable for a direct comparison. |
| Pi | `1dd2354052f7dd9fcdcc3097b87cf4b377853a74` | Runs with host authority by default and deliberately delegates isolation to Gondolin, containers, Sandbox Runtime or OpenShell instead of implementing a kernel. |
| Gemini CLI | `3818efbbfbf8ef029ef53a6ab1093db39971ce83` | Uses restricted tokens, Job Objects and integrity levels on Windows, and containers as a cross-platform alternative. |
| OpenCode | `3016830e253492ef41b6cc00dbed623e5989279b` | Permission decisions do not themselves sandbox its host shell; approval and technical confinement remain distinct concerns. |
| Gentle Pi / Gentle AI | `db788aefa2cdbc3504ab7723c1f270ebbfe29caa` / `a440e791c342b69ca79f7759e697fc88c1272ca5` | Own UI and review/delegation behavior but do not supply Tesota's command-isolation boundary. |
| LemmaScript | `98b94126e37afb46903889b7b5d39347c6db559d` | Formal verification can strengthen selected predicates, but a proof tool is not an operating-system sandbox. |

The principal published contracts were the
[Codex sandbox and approval guide](https://developers.openai.com/codex/agent-approvals-security),
[Docker bind-mount guide](https://docs.docker.com/engine/storage/bind-mounts/),
[Docker none-network guide](https://docs.docker.com/engine/network/drivers/none/),
[Anthropic Sandbox Runtime](https://github.com/anthropics/sandbox-runtime),
[Gemini CLI sandbox guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/sandbox.md)
and [OpenShell policy schema](https://docs.nvidia.com/openshell/reference/policy-schema).
They converge on combining filesystem and network enforcement, sanitizing
credentials and owning descendant processes. OpenShell additionally shows a
useful long-term separation between the agent control plane and the sandbox data
plane, but adopting its gateway would exceed the need demonstrated here.

Anthropic Sandbox Runtime now supports Windows, but its Windows setup installs
persistent ACL, WFP and certificate state. That can be a future qualified option;
the bounded comparison did not mutate machine-wide policy merely to exercise it.

## Decision

Use a pinned Docker Linux image as the first command-isolation runner on the
Windows host. The container root and candidate mount are read-only. One existing
source file is over-mounted read-write, while build output and verifier scratch
use separate read-write mounts. The runner has no network, no inherited
credential variables, no added Linux capabilities, no privilege escalation,
a non-root identity, a read-only root filesystem and explicit PID, memory, CPU,
temporary-storage and time bounds.

The image is addressed by digest and must already exist locally. Tesota uses
`--pull=never`; a missing runtime or image, rejected hardening flag, malformed
probe result, unconfirmed cancellation or unconfirmed container cleanup fails
closed.

The installed Codex native Windows sandbox remains a comparison only. Under the
same fixed probe and an explicit permission profile, it passed the write,
synthetic-environment and descendant-settlement controls, but read the outside
sentinel and reached a positive local network control. Those observations are
compatible with a workspace-write model that protects writes more narrowly than
reads and with native network enforcement requiring additional installed setup,
but they do not satisfy Tesota's strict candidate-only, offline contract.

`src/command-isolation.ts` owns the fixed policy and assessment. The separate
qualification command owns fixture preparation and lifecycle observation. Model
output and repository configuration cannot change the image, command, mounts,
limits or evaluation criteria.

## Evidence and limits

The network result is admitted only after an unconfined control reaches the same
ephemeral listener: directly on Windows for the native comparison and through a
private internal Docker network for the container comparison. The synthetic
credential is present in each launcher environment but excluded from the child.
The descendant writes a ready marker before cancellation and would write a late
marker if it survived; Tesota also requires confirmed container, control-server
and network cleanup. SIGINT is converted to the same owned abort path, which
returns 130 only after cleanup.

The 2026-09-13 Windows run and reproduction instructions are retained in the
[isolation experiment](../../experiments/isolation/README.md). Its verdict is
**internal-decision-ready** for selecting the Docker runner for the next bounded
increment. It is not a public security certification, an exploit-resistance
benchmark, a Linux-host qualification or evidence for commands other than the
fixed probe.

The first proposed code increment now uses the stricter no-mount form of this
runner: Tesota sends only the admitted pure function and immutable oracle over
stdin to the pinned, offline container. The verifier identity includes the shared
container policy, and unconfirmed cleanup fails closed. The successful live cycle
does not qualify candidate repository execution.

Broader commands, dependency installation, selective network, new-file grants,
multiple writable source paths and other host platforms each need their own
admitted contract and evidence.
