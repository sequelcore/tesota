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
| `mxc` | the [native sandbox](#native-sandbox): workspace filesystem, allowlist network, no secrets, unbounded |
| `wsl` | the [WSL sandbox](#wsl-sandbox), a candidate: workspace filesystem, allowlist network, no secrets, unbounded |

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
the sandbox on Windows 11: the Windows Hypervisor Platform, Docker
Sandboxes, a Docker sign-in and a deny-all network policy. It shows each missing step and its command, runs it when the operator
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

Preparation stops when its session closes, switches sandbox or Tesota quits
([sessions](sessions.md#what-a-session-holds)). The native sandbox stops the
dependency install under way and releases its drive and proxy; Docker
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
- **A microVM rather than a native Windows sandbox:** in September 2026 the
  only mature native option was Codex's, needing elevated setup, dedicated
  identities, ACLs and firewall rules; Claude Code's sandbox does not run on
  native Windows. A microVM costs about 30 seconds per session, hidden by
  preparing at session open.
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

## Native sandbox

Decision 030; evidence in the
[native sandbox landscape](../research/native-sandbox-landscape.md). The goal
is that, once Tesota is installed, commands run confined with no Docker, no
administrator rights and no question per command, at close to the host's own
speed. It is built on Windows 11 24H2 and later (`src/mxc-environment.ts`);
Linux and macOS come next.

**Threat model.** It confines the agent's mistakes, such as deleting or
overwriting the operator's files, and what prompt injection would try: reading
credentials or sending data to arbitrary servers. It does not stop code that
exploits the operating system's kernel; only a virtual machine, such as Docker
Sandboxes, does. The documentation says so wherever a provider is named.

**Qualified on each machine, not promised.** Before a provider declares a
guarantee, Tesota's own controls pass on the operator's machine: a write
outside the workspace, a read of the operator's credentials and documents, a
direct connection to the internet, and stopping a command and its children.
The check takes about 20 seconds the first time, in a scratch workspace
(`src/execution-qualification.ts`); its result is saved in
`~/.tesota/qualification.json` and repeated when the Windows build or the
MXC release changes, and a result that withdrew a claim is tried again after
a day, since a missing network can fail it once.
A provider declares only the guarantees that passed, so a host where one
control fails, such as macOS, where MXC's proxy is cooperative, keeps asking
before commands without a rule written for it.

**Components.** Each has one owner, and only the adapter names MXC, so the
native sandbox can later become a project of its own:

| Component | Owns | Reuses |
| --- | --- | --- |
| The execution interface | prepare, run, dispose and guarantees | Unchanged; `workspace` is defined precisely below |
| The `mxc` provider | Turning one command into an MXC policy and running it | `@microsoft/mxc-sdk`, pinned to an exact version |
| The egress proxy | The allowlist: package registries and destinations the operator allows; refused destinations for the existing network question | Web access's public-address check, so the proxy cannot reach the operator's own network |
| Qualification | The controls on the operator's machine and their saved result | The live suite's controls |
| The choice | `tesota sandbox` and the operator's preference | `chooseSessionExecution` |
| The live suite | The same controls for every provider | The Docker Sandboxes suite, made provider-neutral |

**One command.** Each command runs in its own MXC `processcontainer`, about
150 ms to start in the spike; the backend has no session that outlives a
command. It runs in Windows PowerShell 5.1, as a script file written with a
byte-order mark and run with `-File`, which reports errors as text: Git Bash
cannot start in MXC's container, and Codex's Windows shell is PowerShell too.
The agent is told which shell it has.

**The workspace is on a drive of its own.** Inside MXC's BaseContainer a
command cannot query a folder it is not granted, so tools that resolve paths
by walking from the drive root fail: Git, npm and Node scripts among them.
MXC's answer, `enumeratePaths`, lists folders without reading files, but
needs a process security environment Windows 11 has not released: GitHub
Copilot's MXC sandbox requires an Insider build for the same reason, and
Codex avoids it by letting commands read the whole disk. So each prepared
sandbox maps the folder that holds its workspace to a free drive letter with
`subst`, which needs no administrator rights, and commands run in the
workspace one level below the drive's root, at `T:\repo`, with nothing above
the drive (decision 037). The workspace is not the drive's root itself
because Bun's script runner fails there (`bunsh: No such file or directory:
T:\T:`), on any drive, so every `bun run` check failed. The drive's folder is
readable, so tools can resolve the workspace's parent, and everything in it
except the workspace and its sandbox folder, which is Tesota's record of the
session, such as its review journal and source snapshot, is denied through
MXC's `deniedPaths`, read afresh before each command so records written since
are denied too: a command can list their names, never read or write them.
The grants name the real folders. Node runs with `--preserve-symlinks` and
`--preserve-symlinks-main`, so npm does not walk its own install folder.

Preparing acquires the proxy and then the drive, and a later step that fails
or is stopped, such as the dependency install, releases both, in reverse
order, before the error is reported (`AsyncDisposableStack`); a failed release
does not stop the others. The drive is removed when the sandbox is disposed or released, and quitting
waits, up to five seconds, for every session's sandbox to be disposed before
the process exits. A `subst` drive lasts until the operator signs out,
whatever becomes of the process that mapped it, so a session that never
disposes, such as one whose terminal is closed, would leave its drive behind.
Each drive therefore has a lease in `~/.tesota/drives`, naming its letter,
the folder it maps and the process that mapped it, and preparing any sandbox
first removes every drive whose lease names that letter and whose process is
no longer running (`src/verification/drive-release-rule.ts`); a lease an
earlier version kept beside the workspace is still read. A drive without a
lease is never removed: it may be the operator's own. Command output names
paths on that drive; Tesota's file tools keep the real ones. When the SDK
exposes `enumeratePaths` and qualification finds the host reports
`fs_enumerate`, the workspace keeps its real path instead.

**Dependencies are installed before the agent starts, on this computer.**
Package managers cannot install inside this sandbox on released Windows:
Bun's installer fails through any drive letter other than the one its files
live on ([oven-sh/bun#39357](https://github.com/oven-sh/bun/issues/39357), a
fix open upstream), and npm has no installed copy it can always reach. So
preparation, as for Docker Sandboxes and as Codex's setup script and
Copilot's setup steps do before their agents, runs the lockfile's install on
the workspace's real path (`src/host-dependency-install.ts`): `bun install
--frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts`. It installs
exactly what the lockfile names; it runs no package's code, as Bun does by
default for packages it does not trust and as OpenSSF's npm guidance advises;
its network goes through the sandbox's proxy, which admits only package
registries; and it uses the repository's own package caches. It runs with the
operator's own variables, so a private registry's configuration applies. A
fingerprint of the manifest and lockfile skips an install nothing changed; a
failed install is reported and the session goes on. A package whose install
script the repository needs is not run: the agent can run it in the sandbox,
or on this computer with the operator's approval. Dependencies the agent adds
later follow the same per-command retry.

**Windows' own quirks.** Windows' own TLS checks certificate revocation on
servers the allowlist does not reach, so Git runs with its OpenSSL backend
inside the sandbox, set through Git's configuration variables for those
commands only, and the network controls pass `--ssl-no-revoke` to Windows'
`curl`; npm and Bun use their own TLS. PowerShell writes its module analysis
cache into the current folder when it cannot resolve its own inside the
container, which left a `Microsoft` folder in the workspace, so it is given
the sandbox's temporary folder (`PSModuleAnalysisCachePath`). `PATH` keeps a
folder of the operator's home only when it is one of the tool folders the
sandbox may read, such as Bun's: a program found first in one it cannot
read, such as a global npm in `AppData\Roaming\npm`, hangs instead of
falling through to the installed one.

**What a command may reach.** It may write the workspace, a temporary folder
of the session's own (set as `TEMP` and `TMP`, rather than the operator's
shared one; MXC replaces what a command is given with a folder deep in the
sandbox's home, where the temporary folders tests make pass Windows' path
limit, so each command's script sets it again, through the drive) and the
repository's package cache. It may read the workspace,
the names beside it on its drive, the tools installed on the host (`node`,
`git`, `bun` from `PATH`) and system files, and never the operator's data or
credentials, nor Tesota's records of the session. Its network reaches only
Tesota's proxy on the loopback address, which Windows' filtering platform
enforces; the proxy resolves each destination itself. The environment passes
only the variables it is given. For a native provider, `workspace` therefore
means: writes only in the workspace and those folders, reads only the
workspace, installed tools and system files; Docker Sandboxes' virtual
machine is stricter, and is said to be. Qualification checks each part on
the machine: besides the controls every provider passes, a package script
must run from the workspace's root, and a file beside the workspace must stay
unread.

**Choice.** `tesota sandbox` shows each sandbox on this machine, what it
proved here and which one is in use (`src/sandbox-command.ts`); `tesota
sandbox use auto`, the default, prefers the native sandbox, then Docker
Sandboxes, then this computer, which asks before each command; `use native`,
`use wsl`, `use docker` or `use host` names one; the WSL sandbox is used only
when named. The choice, kept in
`~/.tesota/sandbox.json`, applies to sessions opened afterwards. Inside a
session, `/sandbox` shows where its commands run and `/sandbox <choice>`
switches that session alone, so one repository that is not trusted can use
Docker while others run natively; `/sandbox default` returns it to the
operator's choice. The session keeps its choice in its record, and a sandbox
named outright is used only when it is ready here, otherwise the session
stays where it was and says why. A switch ends the session's environment and
agent; the next request prepares the new environment and resumes the same
conversation with that environment's tools (bash or PowerShell), with a note
that earlier commands ran elsewhere. A session never switches provider on its
own. The footer names the selected session's sandbox. The
rule that commands run without asking only in a ready provider whose
guarantees held on this machine is `runsWithoutAsking` in
`src/verification/sandbox-qualification.ts`, proved beside the qualification
rules.

**Per command.** In the native sandbox the agent's shell is Pi's `powershell`
tool, and its instructions say where it runs. When the sandbox blocks a
command the task needs, such as `bun install`, the agent may set
`outside_sandbox`: the command then runs on this computer, in Git Bash, only
after the operator approves it, as for any command on this computer; as in
Claude Code, the retry exists only with the operator's approval. Commands never move between two sandboxes: Docker
Sandboxes keeps `node_modules` on its own disk, so a command in one would not
see what the other installed.

**Package caches.** Each repository has its own npm and Bun cache, owned by
Tesota under `~/.tesota`, shared by that repository's sessions, and never the
operator's own cache. npm verifies what it reads from its cache, but Bun
installs by hard link on Windows and Linux, so a file in `node_modules` is the
cached file itself, and a script that changes it changes the cache; a
repository's cache confines that to the same repository, the scope Codex
cloud and GitHub Actions cache by. `tesota sandbox clean` removes a
repository's caches.

**Proved rules.** Choosing a provider: commands run without asking only on a
provider whose qualification on this machine proved both confined files and
an allowlisted network. The proxy's admission: a destination passes only if it
is allowed and resolves to public addresses, the rule `webAdmission` already
proves for web access.

**Targets, measured before adoption:** a session ready in under two seconds
with a saved qualification, against about 30 for Docker Sandboxes; under 300
ms added to each command; the host's own disk and tools, with nothing copied
or installed.

**Phases.** (1) The live suite made provider-neutral, which Docker Sandboxes
passes unchanged: done. (2) The `mxc` provider and the proxy on Windows: done.
(3) Qualification, `tesota sandbox`, the per-command retry and `/sandbox` in
a session: done. (4) Linux with a tester, a clean
Windows 11, then macOS. Later, with evidence from real use, the native
sandbox as a project of its own.

**Rejected.** MXC with every connection refused and no proxy: simpler, but
installing packages would fail. Allowing registries by address: they sit
behind content delivery networks whose addresses change. Tesota's own
AppContainer, Seatbelt and bubblewrap code: security-critical work on three
systems that MXC and Codex already maintain. Docker Sandboxes alone: the
friction this removes.

**Known limits.** A repository's full test suite may not pass in the native
sandbox on released Windows, although the same suite passes on this computer.
With decision 037, `bun run check` for Tesota's own repository runs there,
installs and builds, and 482 of its 554 tests pass; the rest fail for three
reasons, each outside what the sandbox can change today. Windows' native
`realpath` turns a path on the drive back into its real path, whose parent
folders a command cannot query, and code that compares paths then sees two
names for one file; only MXC's `enumeratePaths`, which removes the drive,
ends this. Git's local transports, cloning or fetching from a path, start a
shell that cannot run in the container. And a test that starts a server on
the loopback address and connects to it is refused, since the sandbox
reaches only its proxy there; opening loopback would also reach whatever the
operator runs on this computer. A check that fails for one of these reasons
fails whatever the change; Tesota runs a failed check again on the base
([assurance](assurance.md#verifiers)), so such a failure is shown as already
there and is not sent back to the agent.

**Risks.** MXC is a preview, and Microsoft states that "no MXC profiles should
be treated as security boundaries currently"; Tesota pins its version, repeats
qualification on every update and says so. The proxy runs as an ordinary
process, which MXC calls its development and testing mode; binding the proxy's
identity needs it in an AppContainer of its own, later. The SDK ships about
68 MB of binaries for every platform. MXC documents no CPU or memory limits
for `processcontainer`, so the native provider declares `unbounded`
resources. Windows 10 is not supported and keeps Docker Sandboxes or asking.

## WSL sandbox

Decision 043; evidence in the
[native sandbox landscape](../research/native-sandbox-landscape.md#wsl2-as-the-windows-backend-2026-09-28).
The native sandbox works, but only through accommodations that are Tesota's
to keep: PowerShell instead of the shell used elsewhere, a drive per
workspace, dependencies installed outside the sandbox, a filtered `PATH`,
Git's TLS backend switched, and known limits that only an unreleased Windows
feature removes. The WSL sandbox is the other candidate for Windows' default,
built only far enough to be compared with it on the same machine, controls
and repositories; Cursor runs its Linux sandbox inside WSL2 on Windows for
the same reason. It is chosen only by name (`use wsl`, `/sandbox wsl`). The
comparison decides which one Windows keeps, and the other is removed, with
its tests, documentation and configuration value.

**Threat model.** The native sandbox's, and the boundary is bubblewrap's
Linux namespaces inside WSL's virtual machine, not WSL itself: WSL shares the
operator's Windows drives with every process in it.

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
Tesota's egress proxy, the same one as the native sandbox's, runs in the
WSL process and listens on a Unix socket bound into each sandbox, where a
small relay started before the command passes loopback connections to it;
the proxy variables name that relay. A program that ignores them, or opens
its own sockets, has no route anywhere, which the `network_direct` control
checks. Servers a command starts on its own loopback answer it, as they do
on the host; the native sandbox refuses them. Proxy variables alone would
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

**Known limits, before measurement on Windows.** The workspace stays on the
Windows drive, where WSL reads and writes through a network filesystem
slower than its own disk; `node_modules` avoids it. Resources are unbounded
per command; WSL's virtual machine is bounded as a whole. A command's
output names paths under `/mnt`; the file tools keep the real ones.

## Planned

- Placeholder secrets: a repository declares a secret by name and host, and
  the sandbox sees only a placeholder that the proxy replaces.
- More providers behind the same interface once they pass the same controls:
  remote machines.
- A configurable number of concurrent sessions, and retrying model rate-limit
  errors instead of failing a session.
