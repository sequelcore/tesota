# Installation

Every option the install scripts take, the platforms, the tools Tesota
uses, and how to remove it. [Install](../get-started/install.md) is the
short path.

## Versions

With no version, the script installs the newest release, prereleases
included. To pin one:

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh -s -- <version>
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1))) <version>
```

Run the script again to update. `TESOTA_INSTALL_DIR` installs somewhere
other than `~/.tesota/bin`. The script checks the binary against the
release's `SHA256SUMS` and adds its folder to your `PATH`.

From Command Prompt, which doesn't know `irm`, run
`powershell -c "irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1 | iex"`.

## Platforms

| Platform | Binary |
| --- | --- |
| Linux x64 and arm64, glibc or musl | `tesota-linux-<arch>`, `tesota-linux-<arch>-musl`; on Alpine, install `libstdc++` and `libgcc` first |
| macOS on Apple silicon or Intel | `tesota-darwin-arm64`, `tesota-darwin-x64` |
| Windows x64 and arm64 | `tesota-windows-<arch>.exe` |

An x64 processor without AVX2 gets the `-baseline` build. On macOS and
Linux the agent runs commands in bash when it's on your `PATH`, otherwise
in `/bin/sh` (BusyBox on Alpine: `apk add bash` if your commands need it).

## Check a binary

Each release holds `SHA256SUMS` and a build-provenance attestation per
binary, made from the tagged commit:

```sh
gh attestation verify tesota-linux-x64 --repo sequelcore/tesota
```

The binaries aren't signed for macOS or Windows yet. The scripts download
without a prompt; a binary from a browser needs
`xattr -d com.apple.quarantine <file>` on macOS, and "More info" in
Windows SmartScreen.

## Tools

The binary carries the grammars, LemmaScript and ripgrep. Tests run with
your project's own tools. The rest:

| Tool | Needed for | Without it |
| --- | --- | --- |
| [Git](https://git-scm.com) | Measuring each change from where the request started; on Windows, its bash runs your check commands | Nothing the agent changes is verified, and the receipt says so |
| [Dafny 4](https://dafny.org), as `dafny` | Proving contracts | The code is listed as not proved |
| Java 11 or newer, as `java`, and TLC | [Model checking](../guides/model-checking.md) | Design models aren't checked, and the receipt says why |
| [Quint](https://quint-lang.org), as `quint` | Quint models | Quint models aren't checked; on Windows they can't be, since Quint can't start Apalache there |

The install script installs Dafny 4.11.0 from Dafny's own release, which
carries .NET and Z3, so nothing else is needed:

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh -s -- dafny
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1))) dafny
```

It checks the archive's SHA-256, puts Dafny in `~/.tesota/tools/dafny`,
and adds it to your `PATH`. Dafny has no build for Linux on arm64 or musl,
or for Windows on arm64; install Dafny 4 yourself there.

Tesota finds TLC at `~/.tesota/tools/tla2tools.jar`. It's tested with
TLC 2.19, from [TLA+ tools 1.7.4](https://github.com/tlaplus/tlaplus/releases/tag/v1.7.4),
SHA-256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`:

```sh
mkdir -p ~/.tesota/tools
curl -fsSL -o ~/.tesota/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
sha256sum ~/.tesota/tools/tla2tools.jar  # shasum -a 256 on macOS
```

## Repair commands

`tesota doctor` suggests these commands and never runs them. The Linux
ones are for Debian and Ubuntu. On macOS, follow Homebrew's note to put
`java` on your `PATH`. Restart the
terminal after changing `PATH`.

<!-- doctor-repairs-start -->
| Capability | Windows | macOS | Linux |
| --- | --- | --- | --- |
| dafny | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1))) dafny` | `sh -c "$(curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh)" -- dafny` | `sh -c "$(curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh)" -- dafny` |
| lsc | `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1)))` | `sh -c "$(curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh)"` | `sh -c "$(curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh)"` |
| java | `winget install EclipseAdoptium.Temurin.21.JRE` | `brew install openjdk@21` | `sudo apt-get install default-jre` |
| tlc | `New-Item -ItemType Directory -Force ~/.tesota/tools; Invoke-WebRequest https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar -OutFile ~/.tesota/tools/tla2tools.jar` | `mkdir -p ~/.tesota/tools; curl -fsSL -o ~/.tesota/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar` | `mkdir -p ~/.tesota/tools; curl -fsSL -o ~/.tesota/tools/tla2tools.jar https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar` |
| quint | `wsl npm install -g @informalsystems/quint` | `npm install -g @informalsystems/quint` | `npm install -g @informalsystems/quint` |
| git | `winget install Git.Git` | `brew install git` | `sudo apt-get install git` |
| claude-code | `& ([scriptblock]::Create((irm https://claude.ai/install.ps1)))` | `bash -c "$(curl -fsSL https://claude.ai/install.sh)"` | `bash -c "$(curl -fsSL https://claude.ai/install.sh)"` |
| provider | `tesota` | `tesota` | `tesota` |
<!-- doctor-repairs-end -->

For a provider, open `tesota` and use `/login`. For Claude Code, run
`claude` and `/login`; named accounts use `tesota accounts login <provider>@<name>`.
From a source checkout, repair LemmaScript as [Development](../development.md#set-up)
says.

## API keys

A key in the environment, such as `OPENAI_API_KEY` or `OPENROUTER_API_KEY`,
works without `/login`, including where a terminal won't paste. In
PowerShell:

```powershell
[Environment]::SetEnvironmentVariable("OPENROUTER_API_KEY", "<your key>", "User")
```

Then open a new terminal.

## Uninstall

Delete `~/.tesota/bin` and its line in your shell's startup file or Windows
user `PATH`. From source, run `bun unlink` in `packages/core`. Deleting
`~/.tesota` also removes your settings, sign-ins, sessions, worktrees and
snapshots; [Configuration](configuration.md) lists what's there.
