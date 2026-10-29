# Commands and keys

Run `tesota` in your project folder to open the shell. Use slash commands
inside the shell; use command-line options from your terminal.

## Command line

| Command | |
| --- | --- |
| `tesota` | Opens the shell in the current folder |
| `tesota -p "<request>"` | Runs one request without the shell ([Print mode](../guides/print-mode.md)) |
| `tesota -p -c "<text>"` (also `--continue`) | Continues this folder's most recently changed session: the answer to its question, or a follow-up ([Continuing a session](../guides/print-mode.md#continuing-a-session)) |
| `tesota -p --resume <session> "<text>"` | The same for the session with that id; also `-r` |
| `tesota receipt [--json] [--owner <login or email>]` | Writes the last receipt for a pull request, or as an in-toto Statement ([Receipts](../guides/receipts.md)) |
| `tesota accounts [list]` | Lists your accounts, each with the account it is signed in to ([Several accounts](../guides/models.md#several-accounts-of-one-provider)) |
| `tesota accounts add claude-code\|openai-codex <name>` | Adds an account in one step: its sign-in, then its record |
| `tesota accounts login <provider>@<name>` | Signs an account in again |
| `tesota accounts remove <provider>@<name>` | Removes an account no setting or agent type names |
| `tesota graph --plain <manifest>` | Prints the captured model graph, its default grouping, full variables and TLC's concrete trace without a terminal UI |
| `tesota graph --html <manifest>` | Writes a self-contained HTML viewer beside the capture and prints its absolute path; does not launch a browser |
| `tesota doctor [--json]` | Checks local verification tools and provider sign-ins without changing anything ([Doctor](#doctor)) |
| `tesota --version` | Prints the version |

| Option | For | |
| --- | --- | --- |
| `--model <provider>/<id>` | `-p` | The model for this run |
| `--claimcheck-model <provider>/<id>` | the shell, `-p` | The model that restates contracts for the comparison with your request |
| `--open-cases-model <provider>/<id>`, or `off` | the shell, `-p` | The model that lists the cases your request leaves open |

## Doctor

```sh
tesota doctor
tesota doctor --json
```

Lists Dafny with LemmaScript, Java with TLC, Quint, Git, Claude Code (each
account) and every chat provider with a local sign-in or key: its status,
path, version, probe result, what the receipt loses without it, and a
repair command from [Installation](installation.md#repair-commands). Git,
Dafny, Java with TLC and a model provider are **core**; Quint and each
single provider are **optional**. JSON has the same report:
`capabilities` (`id`, `requirement`, `status`, `path`, `version`, `smoke`,
`consequence`, `repair`, and `entryPoint` for LemmaScript and TLC) and
`exitCode`.

- **available:** the version, help or sign-in probe passed.
- **unavailable:** not found, no provider available, or Quint on Windows,
  where Apalache can't start.
- **failed:** found, but the probe failed, timed out, or found an
  unsupported version (Dafny must be 4, Java at least 11).

Each probe has five seconds and runs in turn. Doctor never installs
anything, runs tests, proofs or model checks, or sends a model request.
Claude Code gets a version probe only, its sign-in unchecked, because its
auth-status command writes files. Providers use pi-ai's local `checkAuth`.
No email, token or credential is printed.

| Exit | Meaning |
| --- | --- |
| 0 | Nothing failed and every core capability is available |
| 1 | Something failed, optional included, or the command errored |
| 2 | A core capability is unavailable, and nothing failed |
| 3 | Invalid arguments |

A nonzero result doesn't stop you using what is available.

## Slash commands

| Command | |
| --- | --- |
| `/login` | Sign in to a model provider, or add an account |
| `/usage` | The usage panel on its Usage tab: how much each account has left in each limit window ([Usage](../guides/models.md#usage)) |
| `/accounts` | The same panel on its Accounts tab: your accounts and their sign-ins; sign one in again, remove one, or press `a` to add one |
| `/logout` | Forget a provider's sign-in |
| `/model` | Choose the model |
| `/settings` | Terminal mode (fullscreen or inline) and thinking level |
| `/new` | Start another session beside this one |
| `/resume` | Open an earlier session of this folder |
| `/agents` | Open the dashboard of sessions |
| `/graph [--plain] [name]` | Open a [model graph](../guides/model-checking.md) a receipt captured; press `o` in the viewer to write HTML and open the system browser; `--plain` appends its text |
| `/compact` | Summarize the older conversation |
| `/mcp` | MCP servers: state, reconnect, sign in and out; also `/mcp login\|logout\|reconnect <server>` |
| `/quit` | End the shell |
| `/<skill> [arguments]` | Run a skill on the arguments ([Starting a skill by name](../guides/instructions-and-skills.md#starting-a-skill-by-name)) |

## Keys

| Key | |
| --- | --- |
| Enter | Send; while the agent works, add input to the run |
| Alt+Enter | Queue a follow-up for when the run ends |
| Alt+Up (Alt+Q on Windows) | Return all pending steers and follow-ups to the input to edit or withdraw |
| Esc | Stop the run and return pending messages to the input |
| Shift+Tab | Switch the permission mode: ask, full access, read only |
| Ctrl+O | Expand or fold tool output and Tesota's cards |
| Ctrl+T | Open the dashboard |
| Ctrl+C | Clear the input; twice on an empty input, end the shell |
| Ctrl+D | End the shell, on an empty input |

A focused question form or dialog owns its keys instead.

## Pending messages

Steers and follow-ups wait above the input, each labeled with when it
arrives: before the next model reply, or when the run would end. The edit
key puts them all back into the input, before any unsent text; edit and
send again, or clear it to withdraw them. Stopping does the same.

## Fullscreen

| Key | |
| --- | --- |
| Page Up, Page Down | Scroll |
| Ctrl+Home, Ctrl+End | Top, bottom |
| Ctrl+Up, Ctrl+Down | Previous or next request |
| Ctrl+Shift+F | Search; Enter and Shift+Enter for the next and previous match, Esc to close |
| Select with the mouse | Copy |

## Dashboard

| Key | |
| --- | --- |
| ↑ ↓ | Select a session |
| Enter | Show it |
| Space | Peek at its last lines |
| `n` | New session |
| `x` | Close it; `y` confirms for a running one |
| Esc | Back |

## Agent questions

Recommended options start unselected. Answers are sent only when you
submit the batch.

| Key | Action |
| --- | --- |
| 1–4, Space | Toggle a choice while choices have focus |
| ↑ ↓ | Move through choices, text and Submit, wrapping at either end |
| ← → | Switch questions outside the text field |
| Tab | Move from choices to text, then Submit, then choices |
| Enter | Toggle a choice, move from text to Submit, or submit the batch on Submit |
| Page Up, Page Down | Scroll descriptions |
| Esc | Dismiss the question |
| Ctrl+C | Stop the run |
| Ctrl+T | Open the session dashboard |

## Usage and accounts panel

| Key | Action |
| --- | --- |
| Tab, Shift+Tab, ←, → | Switch Usage and Accounts tabs |
| `r` | Read usage again |
| ↑ ↓ | Scroll Usage or select an account on Accounts |
| Page Up, Page Down | Scroll Usage by five rows or select the previous or next account on Accounts |
| Enter | Manage a declared account on Accounts: sign in again or remove it |
| `a` | Add an account on Accounts |
| Esc | Close the panel |

## Model graph viewer

For captures, grouping and the browser viewer, see
[Model checking](../guides/model-checking.md).

| Key | Action |
| --- | --- |
| `+`, `=`, `-` | Increase or decrease label detail |
| `g` | Choose grouping on the grouped graph |
| `/` | Search the grouped graph |
| `n`, `p` | Next or previous reported broken rule |
| `t` | Toggle the failing trace |
| `o` | Write HTML and open it in the system browser |
| `f` | Reset pan and center a drawing smaller than the canvas |
| Enter | Expand the selected group |
| Tab, Shift+Tab | Next or previous state |
| Arrow keys | Pan the drawing |
| Page Up, Page Down | Scroll the details panel |
| Mouse click, drag | Select a state, pan the drawing |
| Mouse wheel | Pan vertically over the drawing; scroll over the panel |
| Esc | Back; close a grouping or search input first if one is open |
