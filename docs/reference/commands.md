# Commands and keys

## Command line

| Command | |
| --- | --- |
| `tesota` | Opens the shell in the current folder |
| `tesota -p "<request>"` | Runs one request without the shell ([Print mode](../guides/print-mode.md)) |
| `tesota receipt [--json] [--owner <login or email>]` | Writes the last receipt for a pull request, or as an in-toto Statement ([Receipts](../guides/receipts.md)) |
| `tesota --version` | Prints the version |

| Option | For | |
| --- | --- | --- |
| `--model <provider>/<id>` | `-p` | The model for this run |
| `--claimcheck-model <provider>/<id>` | the shell, `-p` | The model that restates contracts for the comparison with your request |
| `--open-cases-model <provider>/<id>`, or `off` | the shell, `-p` | The model that lists the cases your request leaves open |

## Slash commands

| Command | |
| --- | --- |
| `/login` | Sign in to a model provider |
| `/logout` | Forget a provider's sign-in |
| `/model` | Choose the model |
| `/settings` | Terminal mode (fullscreen or inline) and thinking level |
| `/new` | Start another session beside this one |
| `/resume` | Open an earlier session of this folder |
| `/agents` | Open the dashboard of sessions |
| `/compact` | Summarize the older conversation |
| `/mcp` | MCP servers: state, reconnect, sign in and out; also `/mcp login\|logout\|reconnect <server>` |
| `/quit` | End the shell |
| `/<skill> [arguments]` | Run a skill on the arguments ([Starting a skill by name](../guides/instructions-and-skills.md#starting-a-skill-by-name)) |

## Keys

| Key | |
| --- | --- |
| Enter | Send; while the agent works, steer the run |
| Alt+Enter | Queue a follow-up for when the run ends |
| Alt+Up (Alt+Q on Windows) | Return all pending steers and follow-ups to the input to edit or withdraw |
| Esc | Stop the run and return pending messages to the input |
| Shift+Tab | Switch the permission mode: ask, full access, read only |
| Ctrl+O | Expand or fold tool output and Tesota's cards |
| Ctrl+T | Open the dashboard |
| Ctrl+C | Clear the input; twice on an empty input, end the shell |
| Ctrl+D | End the shell, on an empty input |

Pending messages stay above the input until the loop takes them. Each row
shows its kind and delivery point: a steer at the next model turn, a
follow-up when the run would end. The edit key removes all still-pending
messages from the queue and puts them before any unsent text, separated by
blank lines. Edit and send again, or clear the input to withdraw them.
Stopping the run also restores pending messages; already delivered messages
stay in the conversation.

In fullscreen:

| Key | |
| --- | --- |
| Page Up, Page Down | Scroll |
| Ctrl+Home, Ctrl+End | Top, bottom |
| Ctrl+Up, Ctrl+Down | Previous or next request |
| Ctrl+Shift+F | Search; Enter and Shift+Enter for the next and previous match, Esc to close |
| Select with the mouse | Copy |

In the dashboard:

| Key | |
| --- | --- |
| ↑ ↓ | Select a session |
| Enter | Show it |
| Space | Peek at its last lines |
| `n` | New session |
| `x` | Close it; `y` confirms for a running one |
| Esc | Back |

While answering an agent question, use 1–4 or Space to select options, the
arrow keys to move, and Tab to reach custom text and Submit. Enter on Submit
sends the whole batch; a recommended option starts unselected. Esc dismisses
the question, Ctrl+C stops its run, and Ctrl+T opens the session dashboard.
Page Up and Page Down scroll the question's descriptions;
moving to another choice or field brings it into view.
