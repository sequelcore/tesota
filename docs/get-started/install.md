# Install

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1 | iex
```

On Windows (including Windows 10), use **Windows Terminal**, rather than
the classic Windows PowerShell console. In the classic console, Ctrl+V and
right-click may not paste into Tesota's message box or API-key fields. Use
the window menu (**Alt+Space → Edit → Paste**) instead, or install Windows
Terminal with `winget install Microsoft.WindowsTerminal` (or from the
Microsoft Store), open PowerShell inside it, and run Tesota there.

Open a new terminal and check it:

```sh
tesota --version
```

Tesota is in alpha, and its releases on GitHub are prereleases: a `tesota`
binary for each platform, which runs without Bun or a checkout. The script
picks the binary for your system, checks it against the release's
`SHA256SUMS`, and installs it as `~/.tesota/bin/tesota` (`tesota.exe` on
Windows). It then adds that folder to your `PATH`, in your shell's startup
file or your Windows user `PATH`.

## Choose a version

With no version, the script installs the newest release, prereleases
included. To install a given one, pass its number:

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh -s -- <version>
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1))) <version>
```

To update, run the script again. `TESOTA_INSTALL_DIR` installs somewhere
other than `~/.tesota/bin`.

| Platform | Binary |
| --- | --- |
| Linux x64 and arm64, glibc or musl | `tesota-linux-<arch>`, `tesota-linux-<arch>-musl`. On Alpine, install `libstdc++` and `libgcc` first |
| macOS on Apple silicon or Intel | `tesota-darwin-arm64`, `tesota-darwin-x64` |
| Windows x64 and arm64 | `tesota-windows-<arch>.exe` |

An x64 processor without AVX2 gets the `-baseline` build of its binary.

On macOS and Linux the agent runs commands in bash when it's on your
`PATH`, and otherwise in `/bin/sh`; the agent is told which. On Alpine
that is BusyBox's `sh`; install `bash` (`apk add bash`) if your commands
need it.

### Check a binary yourself

Each release holds `SHA256SUMS` and a build-provenance attestation for each
binary, made by the release workflow from the tagged commit. With the
[GitHub CLI](https://cli.github.com):

```sh
gh attestation verify tesota-linux-x64 --repo sequelcore/tesota
```

The binaries aren't signed for macOS or Windows yet. The scripts download
with `curl` and `Invoke-WebRequest`, so nothing asks. A binary downloaded
in a browser is another matter: macOS Gatekeeper refuses to open it until
you run `xattr -d com.apple.quarantine <file>`, and Windows SmartScreen
asks you to confirm under "More info".

## Tools the binary doesn't include

The binary carries what verification reads: the grammars, LemmaScript and
ripgrep. Install the others you need:

| | Needed for | Without it |
| --- | --- | --- |
| [Git](https://git-scm.com) | Measuring each change from where the request started. On Windows, Git's bash also runs your project's check commands | Outside a repository, Tesota measures changes from its own snapshot of the folder |
| [Dafny 4](https://dafny.org), as `dafny` on your `PATH` | Proving LemmaScript contracts | Nothing is proved, and the receipt lists the code as not proved |
| Java 11 or newer, as `java` on your `PATH`, and TLC (below) | [Model-checking](../guides/model-checking.md) TLA+ and Quint models | Design models aren't checked, and the receipt says why |
| [Quint](https://quint-lang.org), as `quint` on your `PATH` | Model-checking Quint models | Quint models aren't checked. On Windows Quint can't start the Apalache it needs, so they aren't checked there either way |

Tests run as your project runs them, so they need only your project's own
tools.

Tesota finds TLC at `~/.tesota/tools/tla2tools.jar`. It's tested with
TLC 2.19, from the [TLA+ tools 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4)
release, whose `tla2tools.jar` has SHA-256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`:

```sh
mkdir -p ~/.tesota/tools
curl -fsSL -o ~/.tesota/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
sha256sum ~/.tesota/tools/tla2tools.jar  # shasum -a 256 on macOS
```

## Check your tools

Run `tesota doctor` (or `tesota doctor --json`) before a session. It only
reads local configuration and runs bounded version/help commands. It never
installs, downloads, refreshes credentials or sends a model request. A local
sign-in check does not establish that a provider will accept a request.
Claude Code is version-only: its sign-in is explicitly not checked, because
its auth-status command writes configuration files. This does not affect the
exit code.
[Commands](../reference/commands.md#doctor) documents statuses and exit codes.

### Repair commands

Doctor derives its repair commands from this table, embedded in the binary;
these commands are suggestions for you to run, never actions it takes.
The Linux package commands below are for Debian/Ubuntu; use your distribution's
package manager elsewhere. Dafny's command needs the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).
For Java on macOS, follow Homebrew's printed instructions to put `java` on PATH.
The TLC command downloads the jar described above; verify its checksum there.
LemmaScript is bundled in a release; from source follow [Development](../development.md#set-up).
Quint's TLC backend is not supported on Windows; use TLA+ instead, or run
Tesota and Quint together on Linux (including WSL).

<!-- doctor-repairs-start -->
| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| dafny | `dotnet tool install --global dafny --version 4.11.0` | `dotnet tool install --global dafny --version 4.11.0` | `dotnet tool install --global dafny --version 4.11.0` |
| lsc | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1)))` | `sh -c "$(curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh)"` | `sh -c "$(curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh)"` |
| java | `winget install EclipseAdoptium.Temurin.21.JRE` | `brew install openjdk@21` | `sudo apt-get install default-jre` |
| tlc | `New-Item -ItemType Directory -Force ~/.tesota/tools; Invoke-WebRequest https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar -OutFile ~/.tesota/tools/tla2tools.jar` | `mkdir -p ~/.tesota/tools; curl -fsSL -o ~/.tesota/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar` | `mkdir -p ~/.tesota/tools; curl -fsSL -o ~/.tesota/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar` |
| quint | `wsl npm install -g @informalsystems/quint` | `npm install -g @informalsystems/quint` | `npm install -g @informalsystems/quint` |
| git | `winget install Git.Git` | `brew install git` | `sudo apt-get install git` |
| claude-code | `& ([scriptblock]::Create((irm https://claude.ai/install.ps1)))` | `bash -c "$(curl -fsSL https://claude.ai/install.sh)"` | `bash -c "$(curl -fsSL https://claude.ai/install.sh)"` |
| provider | `tesota` | `tesota` | `tesota` |
<!-- doctor-repairs-end -->

For provider repairs, open `tesota` and use `/login`. For Claude Code,
install it if needed, then run `claude` and `/login`; named accounts use
`tesota accounts login <provider>@<name>`. For LemmaScript, reinstall the
binary with the listed command, or repair the source checkout's dependencies
following Development. Restart your terminal after changing PATH.

## Sign in to a model

Open Tesota in any folder and type `/login`:

```sh
tesota
```

`/login` lists the providers you can sign in to: some with your account,
others with an API key. An API key in the environment, such as
`OPENAI_API_KEY`, works without `/login`. Then `/model` picks the model.
For Claude on a Claude plan, Tesota uses your own Claude Code; see
[Models](../guides/models.md#claude-through-claude-code).

To run Tesota from a checkout instead, see
[Development](../development.md#set-up).

## Uninstall

Delete `~/.tesota/bin`, and its line in your shell's startup file or your
Windows user `PATH`. Installed from source with `bun link`, run
`bun unlink` in `packages/core` instead.

Tesota keeps its state in `~/.tesota`: your settings, sign-ins, sessions,
and the worktrees and snapshots it makes. Delete that folder to remove it
all, the installed binary included. [Configuration](../reference/configuration.md)
lists what's in it.

## Next

[Your first session](first-session.md).
