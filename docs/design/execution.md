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
**dispose** of it. Preparing can be stopped: the provider then releases what
it had acquired and rejects, and an environment it finishes preparing anyway
is still released through dispose. Pi's shell tool reaches it through an adapter that drops the
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
silent fallback to a weaker provider. The controls are one module for every
provider (`src/execution-controls.ts`): each guarantee claimed selects its
controls, every environment must also work in its workspace and stop what it
runs, and each control is a small probe run inside and judged from the host.
File and process probes are JavaScript, so no shell is assumed; network probes
use `curl`, which honors a sandbox's proxy, and one more opens a connection
to a refused destination's address directly, ignoring the proxy, since proxy
variables confine only programs that honor them. That control passes only
when the connection is refused inside while this computer connects to the
same address; a connection that opened fails it whatever happened after, and
a result that shows neither is indeterminate and fails too
(`directConnection` in `src/verification/direct-connection-rule.ts`,
proved). Run against the host provider,
which confines nothing, the confinement controls fail, which shows they can
tell a sandbox from none.

## Providers

| Provider | Guarantees |
| --- | --- |
| `host` | host filesystem, open network, no secrets, unbounded |
| `docker-sandboxes` | workspace filesystem, open network while its allowlist is reviewed (decision 044), no secrets, bounded |
| `wsl` | the [WSL sandbox](#wsl-sandbox), Windows' default: workspace filesystem, allowlist network, no secrets, unbounded |

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

Its network is declared `open` for now (decision 044). With the corrected
`network_direct`, a client that ignored the proxy opened a TCP connection.
Docker documents a transparent proxy that allows a TCP connection only when a
policy rule matches the destination, but not what a refused connection
receives first, so the control cannot tell the proxy from the destination.
Until a controlled server shows whether anything reaches it
([#166](https://github.com/sequelcore/tesota/issues/166)), Docker
Sandboxes is not a place where commands run without asking; there is no
Docker with approval either, so its sessions run on this computer and ask.
`tesota sandbox`, `tesota setup` and `/sandbox` say why a ready provider is
not used when it does not confine files or network.

Every check runs with a 15-minute limit, and only the end of its output is
kept.

## Where commands run

Decision 025. Tesota has no permission modes to switch. Three things that
other harnesses fold into their modes are separate here:

| | Rule |
| --- | --- |
| **Where commands run** | In a **sandbox** when a provider is ready and its `workspace` filesystem and `allowlist` network hold on this machine, and on **this computer** (the host) otherwise. The operator's choice (`tesota sandbox`, decision 030) orders the sandboxes; nothing switches it during a session |
| **When the operator is asked** | Follows from where commands run and is not a setting: on this computer every command asks (yes, always for this session, or no); in the sandbox commands run without asking, and a destination the network refused asks |
| **Where edits land** | Always the session's own copy of the repository; nothing reaches the repository until the operator applies a result after its checks and review |

On this computer an approved command runs with the operator's permissions,
files, network and credentials; it works on any machine with no setup. The
line beside the prompt names where commands run, `sandbox` or `this computer
· asks first`, followed by the selected agent model; the code's `host` is
shown as "this computer". `tesota setup` prepares
the chosen sandbox: for the WSL sandbox, WSL itself, Tesota's distribution
and a restart of it; for Docker Sandboxes, the Windows Hypervisor Platform,
Docker Sandboxes, a Docker sign-in and a deny-all network policy. It shows
each missing step and its command, runs it when the operator confirms, and
stops at a restart or a failure; without a terminal to ask in, it only lists
what is missing.

## Network

When an agent command is refused a destination, the sandbox's proxy log names
it as an exact `host:port`. The environment returns the destinations its
network refused while each command ran with the command's result, measured by
its own clock, never compared with the host's: WSL's clock, for one, can run
a fraction of a second behind Windows'. After the command the operator is asked
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
operator types; the first request waits for it otherwise. The WSL sandbox
runs only the lockfile install, with Tesota's own Node and Bun
([WSL sandbox](#wsl-sandbox)). In Docker Sandboxes, Tesota reads the
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

Preparation stops when its session closes, switches sandbox or Tesota quits
([sessions](sessions.md#what-a-session-holds)). The WSL sandbox ends its
process, which stops the dependency install under way and closes its proxy;
Docker
Sandboxes stops between steps, since a step already running in `sbx` runs to
its own time limit, and the sandbox it keeps by name is removed with its
workspace.

## Why

- **Approval and isolation are separate settings**, as in Codex and Claude
  Code; per-command approval alone defeats unattended and parallel work.
- **The agent loop and its credentials stay outside the boundary; commands
  go inside**, as in Codex's exec server and OpenHands.
- **Pluggable environments**, as every surveyed harness that isolates keeps
  them; vendor names stay inside provider adapters.
- **Linux's isolation inside WSL2 on Windows** (decision 047): Windows'
  native options need elevated setup and dedicated identities (Codex) or a
  preview that is not yet a security boundary (MXC), and make ordinary
  toolchains behave differently; Claude Code's sandbox does not run on
  native Windows, and Cursor runs its Linux sandbox inside WSL2.
- **This computer when there is no sandbox:** requiring isolation before
  first use would add friction to work that asking before each command
  already covers.
- **No permission modes.** Codex separates the sandbox, what is technically
  possible, from the approval policy, when a person is asked, and presents
  combinations as presets; Claude Code's permission modes set only when it
  asks, and reserve running without asking for isolated containers and VMs.
  Tesota keeps the one setting that protects the operator, where commands
  run, and derives when it asks from it, so there is no mode to set wrong.
  Its private copy is what other harnesses' read-only or plan modes provide:
  a phase in which nothing can be written to the repository, which in Tesota
  lasts until the operator applies. A plan is asked for in the request.

## WSL sandbox

Decisions 030, 043 and 047; evidence in the
[native sandbox landscape](../research/native-sandbox-landscape.md) and its
[WSL2 section](../research/native-sandbox-landscape.md#wsl2-as-the-windows-backend-2026-09-28).
On Windows, commands run confined without asking in a Linux sandbox inside
WSL2, as Cursor runs its own there, with Linux's isolation as Codex and
Anthropic's Sandbox Runtime use it: bubblewrap namespaces and a network whose
only exit is Tesota's proxy. It replaced a native Windows sandbox on
Microsoft's MXC (decision 047), which worked only through accommodations that
were Tesota's to keep and failed 44 of Tesota's own tests for reasons only an
unreleased Windows feature removes. Linux and macOS come later, for a real
consumer, under the same controls.

**Threat model.** It confines the agent's mistakes, such as deleting or
overwriting the operator's files, and what prompt injection would try:
reading credentials or sending data to arbitrary servers. The boundary is
bubblewrap's Linux namespaces inside WSL's virtual machine, not WSL itself,
which shares the operator's Windows drives with every process in it. It does
not stop code that exploits the Linux kernel: such code reaches WSL, and
through its drives the operator's files. Only a virtual machine per sandbox,
such as Docker Sandboxes', stops that. The documentation says so wherever a
provider is named.

**Qualified on each machine, not promised.** Before a provider declares a
guarantee, Tesota's own controls pass on the operator's machine: a write
outside the workspace, a read of the operator's credentials, of what lies
beside the workspace and of the host's variables, a package script from the
workspace's root, a refused destination through the proxy and one reached
directly, and stopping a command and its children. The check runs once in a
scratch workspace (`src/execution-qualification.ts`); its result is saved in
`~/.tesota/qualification.json` and repeated when the Windows build, WSL's
kernel, bubblewrap, Node or the controls change, and a result that withdrew
a claim is tried again after a day, since a missing network can fail it once.
A provider declares only the guarantees that passed.

**Components.** `src/wsl-environment.ts` is the provider, the only module
that names WSL; `src/bubblewrap-sandbox.ts` is the process it starts inside
WSL, one per prepared environment, and knows only Linux. They exchange JSON
lines over `wsl.exe`'s standard input and output: run a command with its
folder, variables and time limit, stop one, report what the proxy refused,
allow destinations. When the process's input ends, it stops every command,
confirms each has ended and closes its proxy.

**Tesota's own distribution.** `tesota setup` with `use wsl` installs WSL if
it is missing, creates a distribution named `tesota` from Ubuntu 24.04, and
runs one script in it as root: bubblewrap and Git from the distribution,
Node and Bun at Tesota's own pinned versions under `/opt/tesota` through the
pinned, hash-checked mise (as the Docker Sandboxes kit does), a user of its
own, and `/etc/wsl.conf` with Windows interop off and Windows' drives owned by
that user. A distribution created without its first-run setup has root as its
default user, and WSL mounts Windows' drives as their default user's, so Git
refused the workspace as dubious ownership and `chmod` failed during
`git init`. WSL applies these settings only when the distribution starts
again. The sandbox's check therefore tells two cases apart: a configuration
that does not ask for them sends setup back to its script, and one that asks
for them while interop is still on or a drive, such as `/mnt/c`, is still
another user's is applied by restarting the distribution
(`wsl.exe --terminate tesota`). Only Windows' drives count, as WSL tells them
from its other shares, such as its GPU drivers, which stay root's
(`distributionStep`, `settingsAsked` and `countsAsDrive` in
`src/verification/wsl-settings-rule.ts`, proved).
Tesota starts `wsl.exe` from the Windows system directory, never by name, and
its process as that user, never root, with Node from the Windows drive's
copy of Tesota. Keeping a distribution of its own leaves the operator's
distributions, their users and their interop setting alone.

**One command.** Each command runs in its own bubblewrap sandbox with new
user, process, network, IPC, UTS and cgroup namespaces, about 55 ms to start
on Linux. Its root holds only `/usr` and `/etc` read-only, the system's
links (`/bin` to `usr/bin`), the installations of the tools on `PATH`
read-only, except the operator's home, a folder that holds it, and Windows'
drives (`readsToolFolder` in `src/verification/tool-folder-rule.ts`,
proved), and writable: the workspace at its path under `/mnt`, the session's
own home, a temporary folder at `/tmp`, the repository's package cache and,
for a JavaScript package, the workspace's `node_modules` on WSL's own disk, as
Docker Sandboxes keeps it. Nothing else of WSL or Windows is in it. A command
runs in `/bin/sh` and gets only its `PATH`, its home, the proxy and what it
was given.

**Network.** A command's network namespace has only a loopback interface.
Tesota's egress proxy runs in the WSL process and listens on a Unix socket bound into each sandbox, where a
small relay started before the command passes loopback connections to it;
the proxy variables name that relay. A program that ignores them, or opens
its own sockets, has no route anywhere, which the `network_direct` control
checks. Servers a command starts on its own loopback answer it, as they do
on the host. Proxy variables alone would
confine nothing: MXC's own WSL container backend has no proxy and rejects
per-host egress rules, and its bubblewrap backend shares the host's network.

**Windows programs.** WSL's interop starts a Windows program from Linux
through a socket under `/run/WSL`, whose interpreter the kernel opens once
for every process; no sandbox mounts `/run`, and interop is off in Tesota's
distribution besides. The live suite runs a copy of `whoami.exe` from the
workspace and expects it to fail.

**Stopping.** Stopping a command kills its bubblewrap process; the
sandbox's first process dies with it (`--die-with-parent`), and the kernel
ends every other process in its namespace before that one ends, detached and
`setsid` ones included. The sandbox reports the first process's id, and a
stop is confirmed only once it is gone.

**Preparing.** The WSL process starts, the proxy listens, and the
repository's lockfile install runs inside the sandbox through the proxy,
with a fingerprint in the sandbox's home that skips an unchanged install.
Mise's files and `.tesota/setup.sh` need toolchain downloads that the
sandbox does not open yet, so they are reported as a failed step and not
run, and runtime versions a repository pins are not installed: commands use
Tesota's Node and Bun. Qualification depends on the Windows build and the
versions of bubblewrap, WSL's kernel and Node.

**Choice.** `tesota sandbox` shows each sandbox on this machine, what it
proved here and which one is in use (`src/sandbox-command.ts`); `tesota
sandbox use auto`, the default, prefers the WSL sandbox, then Docker
Sandboxes, then this computer, which asks before each command; `use wsl`,
`use docker` or `use host` names one. The choice, kept in
`~/.tesota/sandbox.json`, applies to sessions opened afterwards. Inside a
session, `/sandbox` shows where its commands run and `/sandbox <choice>`
switches that session alone; `/sandbox default` returns it to the operator's
choice. The session keeps its choice in its record, and a sandbox named
outright is used only when it is ready here, otherwise the session stays
where it was and says why. A switch ends the session's environment and
agent; the next request prepares the new environment and resumes the same
conversation, with a note that earlier commands ran elsewhere. A session
never switches provider on its own. Commands never move between two
sandboxes: each keeps `node_modules` on its own disk, so a command in one
would not see what the other installed.

**Package caches.** Each repository has its own npm and Bun cache, owned by
Tesota under `~/.tesota`, shared by that repository's sessions, and never the
operator's own cache. npm verifies what it reads from its cache, but Bun
installs by hard link, so a file in `node_modules` can be the cached file
itself, and a script that changes it changes the cache; a repository's cache
confines that to the same repository, the scope Codex cloud and GitHub
Actions cache by. `tesota sandbox clean` removes a repository's caches.

**Proved rules.** Choosing a provider: commands run without asking only on a
provider whose qualification on this machine proved both confined files and
an allowlisted network (`runsWithoutAsking`). The proxy's admission: a
destination passes only if it is allowed and resolves to public addresses,
the rule `webAdmission` proves for web access. A direct connection is
blocked, connected or indeterminate (`directConnection`). The tool folders a
command reads (`readsToolFolder`), and the distribution's settings and drives
(`distributionStep`, `settingsAsked`, `countsAsDrive`).

**Measured on Windows** (one run each, caches not controlled; decision 047):
the first preparation with dependencies took 17.4 s, a later one 3.65 s,
hidden by preparing at session open; Tesota's own check ran its first test
group in 112 s with 616 of 617 tests passing, where the MXC sandbox took
241 s and failed 44.

**Known limits.** The workspace stays on the Windows drive, where WSL reads
and writes through a network filesystem slower than its own disk;
`node_modules` avoids it. Installing WSL needs an administrator prompt and a
restart once. Resources are unbounded per command; WSL's virtual machine is
bounded as a whole. A command's output names paths under `/mnt`; the file
tools keep the real ones.

**Rejected.** MXC's `processcontainer` (decision 047): PowerShell instead of
the shell used elsewhere, a drive per workspace, dependencies installed
outside the sandbox, a filtered `PATH`, Git's TLS backend switched, loopback
servers refused, and 44 of Tesota's tests failing until Windows releases
`enumeratePaths`; Microsoft does not yet call any MXC profile a security
boundary. MXC's WSL container backend: it has no proxy and rejects per-host
egress rules. Proxy variables without a network namespace: they confine only
programs that honor them. Bubblewrap's usual `--ro-bind / /`: in WSL, `/`
holds the operator's Windows drives. Tesota's own AppContainer or Seatbelt
code: security-critical work that others maintain.

## Planned

- Placeholder secrets: a repository declares a secret by name and host, and
  the sandbox sees only a placeholder that the proxy replaces.
- More providers behind the same interface once they pass the same controls:
  remote machines.
- A configurable number of concurrent sessions, and retrying model rate-limit
  errors instead of failing a session.
