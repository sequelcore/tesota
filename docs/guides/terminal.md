# The terminal

## Display modes

| | |
| --- | --- |
| **Fullscreen** (default) | Tesota takes the whole window, as Claude Code and Codex do: scroll, search with Ctrl+Shift+F, select text to copy it. When the shell ends, the conversation is written to your terminal's scrollback |
| **Inline** | Tesota prints into the terminal like a command, and the scrollback is your terminal's own |

`/settings` → **Terminal** switches between them, from the next start. On
Windows over SSH Tesota always runs inline, which remote terminals draw
reliably. On Windows, fullscreen redraws every cell, as Windows' console
needs.

In fullscreen, text you select is copied to the clipboard; where Tesota
can't reach the clipboard, it asks the terminal to copy it. Inline, your
terminal selects and copies as usual.

## The screen

- **The header:** Tesota's name and version, the model and folder, and its
  purpose, in three rows at the top left.
- **The empty stage:** the palo fierro plays once in the free space between
  the header and input, then fades to a faint pose. It stays while you type
  and disappears when you send a message. It never enters scrollback or
  appears over a resumed conversation. In fullscreen, clicking the resting
  tree replays the scene with a tumbleweed.
- **The input:** a full-width band with a `›` prompt, like your messages in
  the conversation. Without background-color support, both use plain rows
  and the prompt. Enter sends; while the agent works, Enter
  steers the run and Alt+Enter queues a follow-up. Pending messages show
  above it, labeled with when they will be delivered. Alt+Up (Alt+Q on
  Windows) returns them to the input to edit or withdraw; stopping the run
  restores them too. See [Commands and keys](../reference/commands.md#keys).
- **The footer:**
  - first, what Tesota knows about the request (`● ready · tests only`,
    the gate's step and timer while it verifies, or the receipt in brief),
    with the context window's use at the right;
  - then the folder and branch, with the model;
  - then statuses: the permission mode, and sessions waiting for you.

On a narrow terminal the model goes first, then the evidence shortens, and
the context's use goes last.

[Commands and keys](../reference/commands.md) lists every key.

## Themes

Tesota draws in `tesota-dark` or `tesota-light`, following your terminal's
background, and switches when it changes.

The themes are drawn for a `#202020` canvas (light: `#edede5`). Tesota's
terminal color schemes, in [`terminal-schemes`](../../terminal-schemes),
set that canvas and a matching ANSI palette. They're optional:

- **Windows Terminal:** copy `windows-terminal/tesota.json` to
  `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\Tesota\`, restart
  Windows Terminal, and choose **Tesota Dark** or **Tesota Light** as a
  profile's color scheme. Set the profile's **Intense text style** to
  **Bold font** to draw bold text bold rather than brighter.
- **Ghostty:** copy the files in `ghostty` to `~/.config/ghostty/themes/`
  and set `theme = light:Tesota Light,dark:Tesota Dark`.
- **WezTerm:** copy the files in `wezterm` to `~/.config/wezterm/colors/`
  and set `config.color_scheme = "Tesota Dark"`.

## Windows

- The agent's shell is PowerShell: PowerShell 7 when installed, otherwise
  Windows PowerShell 5.1.
- Your project's check commands run in Git for Windows' bash, since they're
  written for a POSIX shell.
- Windows Terminal is recommended.

## Related

- [Commands and keys](../reference/commands.md)
