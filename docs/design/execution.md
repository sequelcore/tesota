# Execution

Every command a session runs, the agent's shell commands and the approved
checks, goes through an **execution environment**. The environment decides
what a command can reach; the session's **mode** decides whether it runs
without asking.

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
| `docker-sandboxes` | workspace filesystem, open network while its allowlist is reviewed, no secrets, bounded |
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

Its network is declared `open` for now. With the corrected
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

The operator's **permission mode**, switched with `Shift+Tab` as in Claude
Code and Codex, decides what runs without asking. The sandbox decides what a
command can reach whatever the mode, and every mode records each turn:

| Mode | Edits | Commands |
| --- | --- | --- |
| **Read only** | Refused by the edit and write tools | Every command asks, in the sandbox too, and saved rules do not apply |
| **Accept edits** | Allowed | In a qualified sandbox, run without asking; on this computer, ask unless a saved rule allows them |
| **Full access** | Allowed | Run on this computer without asking, in a sandboxed session too |

Where commands run in Read only and Accept edits: in a **sandbox** when a
provider is ready and its `workspace` filesystem and `allowlist` network hold
on this machine, and on **this computer** (the host) otherwise. The operator's
`tesota sandbox` choice orders the sandboxes. Edits land in the operator's
project for a repository session, and in an isolated workspace for a folder,
a second session or one that chose `/isolate`
([workspace](workspace.md)).

The rules are one module, proved (`editsAllowed`, `commandPlace`,
`commandRunsWithoutAsking`, `offersRule`, `nextMode` and `needsConfirmation`
in `src/verification/permission-mode.ts`). The agent's tools read the mode at
each call, so a switch applies to work under way, and the agent is told the
new mode with the next request. Shift+Tab cycles Read only, Accept edits and
Full access; entering Full access asks the operator once per session, worded
as Codex's own confirmation, with the risk in the warning color, and `Enter`
cancels. The operator stays aware of it without a question at each command: a
session that opens in Full access says so, every later entry leaves a line in
the conversation, and a turn ends with how many commands ran without asking. A session keeps its mode; a new one starts in the mode last
chosen in the repository, and one saved before modes runs in Accept edits.
`tesota run` always runs in Accept edits.

Full access exists because the operator, not Tesota, decides how much to
trust the agent. It gives up what the sandbox provides: commands reach the
operator's files, credentials and network, and files hidden from the agent's
file tools are not hidden from its commands. A turn's changes to the project
can still be reverted, but not what a command did elsewhere. Unlike Claude
Code's auto mode or Codex's auto-review, no classifier judges commands yet;
a reviewer-model mode between Accept edits and Full access is planned.

On this computer an approved command runs with the operator's permissions,
files, network and credentials; it works on any machine with no setup.

**One command on this computer**. A sandbox holds none of the
operator's own programs and logins, where Claude Code and Codex read the
host's, so in a sandboxed session the agent may ask to run one command here
with `run_on_computer`, giving its reason, as Codex's escalation and Claude
Code's retry outside the sandbox do. It runs as Pi's bash in the session's
copy of the repository, with the operator's environment. The operator is
asked, as for any command on this computer, unless a saved rule allows it.
A rule is a command's leading words, such as `gh pr`, saved for the
repository with its approved checks and network (`src/command-rules.ts`).
A command runs without asking only when it reads as plain words joined by
`&&`, `||`, `;` or `|`, never with redirection, expansions, globs, `~`, an
assignment or a lone `&`, and some rule begins every part of it; a rule
has two words or more and never starts with a shell, an interpreter, a
package runner, a command that runs another (`env`, `sudo`, `xargs`, `ssh`)
or a deleting one, compared by the program's name without folder,
extension or version (`beginsWith`, `coveredPart`, `runsWithoutAsking` and
`savableRule` in `src/verification/command-rule.ts`, proved). Tesota offers
the agent's suggested rule when it may be saved and begins the command,
otherwise the command's leading names, up to three; "always" means that
rule, never every later command, as it did before. Rules are offered and
consulted only in Accept edits. Only the operator's mode stops the
questions; the sandbox and saved rules reduce repeated approvals without
giving the agent authority to choose where a command runs.

The
second line under the prompt names the mode, marked with the prompt's chevron
(`·` for Read only, one more `›` for each step of what runs without asking), and
where commands run, such as `›› accept edits on · sandbox · WSL` in the
theme's success color, or `›› accept edits on · this computer · asks first`
and `››› full access on · this computer` in its warning color, so the place and what it permits read at a glance; the code's `host` is
shown as "this computer" (`executionLabel` in `src/session-engine.ts`). The selected agent model has the line above it. `tesota setup` prepares
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
operator types; the first request waits for it otherwise. Both sandboxes set
a repository up from one plan and in the same stages (`src/toolchain.ts`),
always inside the sandbox, never on this computer. Tesota reads the runtimes
the repository pins (`package.json` `packageManager` and `engines`, `.nvmrc`,
`.node-version`, `.bun-version`, `.python-version`) and installs them with
mise, whose pinned binary is checked against a known SHA-256; mise also
installs what `mise.toml` or `.tool-versions` declare. Then it runs
`.tesota/setup.sh` if the repository has one, or otherwise the lockfile
install (`bun install --frozen-lockfile` or `npm ci`).

Only during this phase may the sandbox also reach the hosts toolchains
download from, as Codex cloud, Claude Code on the web and
GitHub's Copilot agent open the network for setup and restrict it for the
agent. In Docker Sandboxes, Tesota removes those rules and reads the
sandbox's rule list back before the agent runs, and deletes the sandbox if it
cannot confirm they are gone; the WSL sandbox's own proxy holds them for
setup alone and confirms them closed ([WSL sandbox](#wsl-sandbox)). Docker
bakes the pinned runtimes into a sandbox kit that `sbx` builds once per set
of versions and reuses for later sessions, and the workspace's
`node_modules` lives on the sandbox's own disk rather than the slower
workspace mount, in both. It does for every workspace, not only one that is
a JavaScript package when the session starts, so a package created and
installed mid-session never writes Linux binaries into the operator's
checkout. A failed step stops setup but not the session, and
the operator and agent are told what failed; a fingerprint of the setup
inputs skips setup when nothing changed.

**A toolchain declared mid-session.** When a check needs a tool the sandbox
lacks, the agent is told to declare it in the repository's `mise.toml`,
which stays with the result as the repository's own toolchain, as a
devcontainer would. Before the next command in the sandbox, Tesota compares
the toolchain plan's fingerprint with the one the sandbox was set up for.
When it changed, the operator is asked once per declaration, with `Enter`
declining, and only on their yes does the sandbox run its setup again
(`refreshToolchain`), its download hosts open only while setup runs. The
agent reads the outcome before that command's output: the tools are ready,
the operator declined, or setup stopped and why. Docker Sandboxes sets up
only when prepared, so there the agent is told the tools are unavailable in
this session, without a question (`toolchainStep` and
`installsDeclaredTools` in `src/verification/toolchain-refresh-rule.ts`,
proved). A command on this computer, through `run_on_computer`, uses the
operator's own tools and is not affected.

Preparation stops when its session closes, switches sandbox or Tesota quits
([sessions](sessions.md#what-a-session-holds)). The WSL sandbox ends its
process, which stops the setup stage under way and closes its proxy; Docker
Sandboxes stops between steps, since a step already running in `sbx` runs to
its own time limit, and the sandbox it keeps by name is removed with its
workspace.

## WSL sandbox

On Windows, commands run confined without asking in a Linux sandbox inside
WSL2: bubblewrap namespaces and a network whose only exit is Tesota's proxy.
Linux and macOS come later, for a real consumer, under the same controls.

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
directly, a toolchain host that setup reached and a command after it cannot,
and stopping a command and its children. The check runs once in a scratch
workspace (`src/execution-qualification.ts`); its result is saved in
`~/.tesota/qualification.json` and repeated when the Windows build, WSL's
kernel, bubblewrap, Node or the controls change, and a result that withdrew
a claim is tried again after a day, since a missing network can fail it once.
A provider declares only the guarantees that passed.

**Components.** `src/wsl-environment.ts` is the provider, the only module
that names WSL; `src/bubblewrap-sandbox.ts` is the process it starts inside
WSL, one per prepared environment, and knows only Linux. They exchange JSON
lines over `wsl.exe`'s standard input and output: run a command with its
folder, variables and time limit, stop one, report what the proxy refused,
allow destinations, set the repository up. When the process's input ends,
it stops every command, confirms each has ended and closes its proxy.

**Tesota's own distribution.** `tesota setup` with `use wsl` installs WSL if
it is missing, creates a distribution named `tesota` from Ubuntu 24.04, and
runs one script in it as root: bubblewrap and Git from the distribution,
Node and Bun at Tesota's own pinned versions under `/opt/tesota` through the
pinned, hash-checked mise (as the Docker Sandboxes kit does), which stays
under `/opt/tesota/mise` to install repositories' tools, a user of its
own, and `/etc/wsl.conf` with Windows interop off and Windows' drives owned by
that user. A distribution created without its first-run setup has root as its
default user, and WSL mounts Windows' drives as their default user's, so Git
refused the workspace as dubious ownership and `chmod` failed during
`git init`. WSL applies these settings only when the distribution starts
again. The sandbox's check therefore tells two cases apart: a configuration
that does not ask for them sends setup back to its script, and one that asks
for them while interop is still on or a drive, such as `/mnt/c`, is still
another user's is applied by restarting the distribution
(`wsl.exe --terminate tesota`). Interop counts as still on while WSL serves
the session an interop server, which it names in `WSL_INTEROP` only when the
distribution has interop on (`interopServed` in `src/bubblewrap-sandbox.ts`).
The `WSLInterop` binfmt entry tells nothing about one distribution: WSL 2's
`mini_init` registers it for the whole virtual machine, whatever a
distribution's `wsl.conf` says (WSL's interop documentation and
`src/linux/init`), so on WSL 2.6.1 a check of the entry asked for a restart
that could never apply. Only Windows' drives count, as WSL tells them
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
own home, mounted at the account's own home path so that programs asking the
system for the home, as Java does, find the same folder as `HOME` (Maven
otherwise misses its settings and loses its downloads after each command),
a temporary folder at `/tmp`, and, on WSL's own disk, the repository's
package caches and the workspace's `node_modules`, as Docker Sandboxes
keeps it; the empty folder it mounts over is removed when the session ends
if the sandbox created it. Nothing else of WSL or Windows is in it. A command
runs in `/bin/sh` and gets only its `PATH`, its home, the proxy and what it
was given.

**Guarded paths.** Inside the workspace, its `.git` is mounted read-only, so
a command reads the repository's history but cannot change its hooks, refs
or configuration, as Gemini CLI's sandbox protects `.git`. Files that may
hold credentials are hidden: each one that exists when the command starts
has an empty, read-only file mounted over it (`guardedPaths` in
`src/bubblewrap-sandbox.ts`). They are environment files (`.env`, `.env.*`),
private keys (`id_rsa` and its kin, `*.key`, `*.p12`, `*.pfx`) and package
registry credentials (`.npmrc`, `.pypirc`, `.netrc`, `.yarnrc.yml`, and
`credentials` in `.aws`, `.cargo` or `.gem`, `.docker/config.json`), found
outside dependency and build folders; in a repository, only those its Git
does not track, since a tracked file is shared work whose history is
readable anyway (`src/secret-files.ts`). The agent's file tools refuse the
same files and leave them out of grep's results. A command run on the
operator's computer, which the operator approves one at a time, sees every
file, and Docker Sandboxes hides none. Setup's stages see them too, so a
private registry's credentials still reach the lockfile install.

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

**Preparing**. The WSL process starts and its proxy listens;
the host then sends one setup message, with the stages, their variables, the
destinations setup may reach and a fingerprint of all of it, and the process
runs it before the agent's first command. Runtimes the repository pins that
Tesota's own Node and Bun do not satisfy, and what its mise files declare,
are installed by the distribution's pinned mise (`/opt/tesota/mise`) into the
repository's **toolchain folder** on WSL's own disk. That folder lies beside
the repository's package caches, under the repository's key (`repositoryKey`
in `src/execution-providers.ts`, a hash of its path whatever its case), so
the repository's sessions share it and no
other repository's can change it, since setup runs the repository's own code
with write access to it; it is writable to setup's stages alone and
read-only to every other command. A last mise stage prints the installed
tools' folders (`mise bin-paths`), and those inside the toolchain folder go
first on `PATH`, ahead of Tesota's runtimes, for the stages after it and the
agent's commands, so `node` is the version `.nvmrc` pins. Then
`.tesota/setup.sh`, or the lockfile install, runs with them.

**Languages found without declaring them** (`src/languages.ts`). The plan also
reads the files each language's projects
already have at the repository's root, so a repository that declares nothing
gets its language, as it would on the operator's own machine:

| Language | Files | Version from | Otherwise | Registries |
| --- | --- | --- | --- | --- |
| Java | `pom.xml`, `build.gradle(.kts)`, `settings.gradle(.kts)`, `.java-version`, `.sdkmanrc` | Maven's release or `java.version`, Gradle's toolchain or compatibility, the version files | 21 | Maven Central, Gradle's |
| Go | `go.mod` | its `toolchain`, else its `go` line | latest | Go's proxy |
| Rust | `Cargo.toml`, `rust-toolchain(.toml)` | the toolchain file's channel | stable | crates.io |
| Python | `pyproject.toml`, `requirements.txt`, `setup.py`, `setup.cfg`, `Pipfile`, `.python-version` | `.python-version`, `requires-python`, the Pipfile | 3.13 | PyPI |
| Ruby | `Gemfile`, `.ruby-version` | the version file, the Gemfile's `ruby` | 3.4 | rubygems.org |
| .NET | `*.csproj` and the like, `*.sln`, `global.json` | `global.json`'s SDK, the highest target framework | 10 | nuget.org |

Fallbacks are fixed where new releases break older builds (Java's build
tools lag its releases, Python's packages lag theirs, and Ruby 4.0 is a
major release) and latest where the language keeps compatibility. A
version enters a script only as digits and dots or a release channel.
Java comes from Eclipse Temurin: mise's default, OpenJDK's own builds,
installed 21.0.2 from January 2024. A Java repository without a Maven or
Gradle wrapper gets Maven or Gradle too, and a stage writes Maven's
`settings.xml` and Gradle's `gradle.properties` in the home with the
sandbox's proxy, since Java ignores proxy variables (Claude Code issues
13372 and 16222). Each language's tools get what they need: rustup's homes
in the toolchain folder, gems in the home, since Ruby's own folder is
read-only to commands, and NuGet's revocation checks offline and .NET's
telemetry off, since both would reach hosts over plain HTTP. The
languages' registries, and the destinations the operator allowed for the
repository, are open from the start, setup included. Mise's files and
`.tesota/setup.sh` still override, and only the root is read, so a
monorepo's subprojects need them.

While setup runs, the proxy also permits the toolchain hosts, and only then:
it holds them apart from what is allowed, ends their tunnels when setup
ends, refuses a connection that finishes opening after it, and reads each
back through the proved rule (`permitted` in
`src/verification/setup-network-rule.ts`). If one still passes, the process
runs no further command and preparation fails. No agent command starts while
setup runs. A record beside the sandbox's home, where no command sees it,
skips a setup that already succeeded in that workspace; a new session's
workspace runs setup again, with the tools already installed. Qualification
depends on the Windows build and the versions of bubblewrap, WSL's kernel
and Node.

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
Tesota, shared by that repository's sessions, and never the operator's own
cache. The WSL sandbox keeps it on WSL's own disk with the repository's
toolchain folder (`~/.local/state/tesota/repositories/<key>` in the
distribution), since Microsoft advises keeping the files a Linux tool works
on out of Windows' drives: with the cache on the Windows drive, Bun copied
every file through WSL's network filesystem, and preparing a session on
Tesota's own repository took 92 s. Its commands can write the cache, where a
script could plant a package; a repository's cache confines that to the same
repository, the scope Codex cloud and GitHub Actions cache by. The cache and
`node_modules` are separate mounts in each command's sandbox, which Linux
does not hard link across, so Bun falls back from its default hard links to
copying each file into `node_modules`, and a change to a file there leaves
the cache as it was. `tesota sandbox clean` removes a
repository's caches and the tools the WSL sandbox installed for it.

**Proved rules.** Choosing a provider: commands run without asking only on a
provider whose qualification on this machine proved both confined files and
an allowlisted network (`runsWithoutAsking`). The proxy's admission: a
destination passes only if it is allowed and resolves to public addresses,
the rule `webAdmission` proves for web access. What it permits during and
after setup: setup's destinations only while setup runs (`permitted`). A
direct connection is blocked, connected or indeterminate
(`directConnection`). The tool folders a
command reads (`readsToolFolder`), and the distribution's settings and drives
(`distributionStep`, `settingsAsked`, `countsAsDrive`).

**Known limits.** The workspace stays on the Windows drive, where WSL reads
and writes through a network filesystem slower than its own disk;
`node_modules` and the package caches avoid it. Installing WSL needs an administrator prompt and a
restart once. Resources are unbounded per command; WSL's virtual machine is
bounded as a whole. A command's output names paths under `/mnt`; the file
tools keep the real ones. Commands reach mise's tools through their folders,
not mise's shims, so the `[env]` settings of a repository's mise file do not
apply to them. Setup opens every toolchain host to whatever setup runs, the
repository's own script included, as the other harnesses' setup phases do.

## Remaining work

One command on this computer
([where commands run](#where-commands-run)) and languages found from project
files ([WSL sandbox](#wsl-sandbox)) are built.

- Placeholder secrets: a repository declares a secret by name and host, and
  the sandbox sees only a placeholder that the proxy replaces.
- More providers behind the same interface once they pass the same controls:
  remote machines.
- A configurable number of concurrent sessions, and retrying model rate-limit
  errors instead of failing a session.
