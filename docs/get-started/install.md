# Install

On macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/sequelcore/tesota/main/install.sh | sh
```

On Windows, in PowerShell, ideally inside [Windows Terminal](https://aka.ms/terminal)
(`winget install Microsoft.WindowsTerminal`):

```powershell
irm https://raw.githubusercontent.com/sequelcore/tesota/main/install.ps1 | iex
```

Open a new terminal and check it:

```sh
tesota --version
```

Tesota is in alpha. The script installs the newest prerelease binary to
`~/.tesota/bin`, checked against the release's checksums. It runs without
Bun or a checkout.

## Add the tools you need

| Tool | For |
| --- | --- |
| [Git](https://git-scm.com) | Verification. Without it the agent still works, but nothing it changes is verified |
| [Dafny 4](https://dafny.org), which the install script adds with `dafny` ([how](../reference/installation.md#tools)) | Proving contracts |
| Java 11+ and TLC | Checking TLA+ and Quint design models |
| [Quint](https://quint-lang.org) | Quint models (not on Windows) |

Tests run with your project's own tools. Then ask Tesota what's missing:

```sh
tesota doctor
```

It prints the command to install each missing tool, and changes nothing
itself.

## Sign in

In your project:

```sh
tesota
```

Type `/login` to sign in to a provider, then `/model` to pick a model. A
Claude plan runs through your own Claude Code; see [Models](../guides/models.md).

Versions, platforms, provenance, API keys and uninstalling are in
[Installation](../reference/installation.md). To run from a checkout, see
[Development](../development.md#set-up).

## Next

[Your first session](first-session.md).
