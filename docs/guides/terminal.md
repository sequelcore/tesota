# The terminal

## Display modes

| | |
| --- | --- |
| Fullscreen (default) | Tesota takes the whole window, as Claude Code and Codex do: scroll, search with Ctrl+Shift+F, select text to copy it. When the shell ends, the conversation is written to your terminal's scrollback |
| Inline | Tesota prints into the terminal like a command, and the scrollback is your terminal's own |

`/settings` → Terminal switches between them, from the next start. On
Windows over SSH Tesota always runs inline, which remote terminals draw
reliably. On Windows, fullscreen redraws every cell, as Windows' console
needs.

In fullscreen, text you select is copied to the clipboard; where Tesota
can't reach the clipboard, it asks the terminal to copy it. Inline, your
terminal selects and copies as usual.

## Pasting

Ctrl+V pastes clipboard text into the focused input, including sign-in key
fields and question answers. In Windows fullscreen mode, right-click also
pastes. Mouse selection and scrolling remain available. An empty or
unavailable clipboard leaves the input unchanged.

When your terminal delivers a bracketed paste, Tesota uses that text without
reading the clipboard again.

## The screen

- **The header:** a small pixel ironwood beside Tesota's name and version,
  the model and folder, and its purpose. The tree blossoms when the latest
  receipt is verified; a new request clears it. The receipt's text says
  the same in words.
- **The empty stage:** a larger, faded ironwood and a saguaro seedling,
  centered between the header and the input. It stays while you type and
  goes when you send a message; it never enters scrollback. The crown
  rustles once when Tesota opens, and again, dropping a leaf, when you
  click either tree. Without extended colors both trees are plain
  silhouettes that don't move.
- **The input:** a full-width band with a `›` prompt, like your messages in
  the conversation. Without background-color support, both use plain rows
  and the prompt. Enter sends; while the agent works, Enter
  steers the run and Alt+Enter queues a follow-up. Pending messages show
  above it, labeled with when they will be delivered. Alt+Up (Alt+Q on
  Windows) returns them to the input to edit or withdraw; stopping the run
  restores them too. See [Commands and keys](../reference/commands.md#keys).
- **The footer:** one row. On the left, what Tesota knows about the
  request: what it can verify (`● ready · tests only`), the step and its
  timer while it verifies, or the receipt in brief (`✓ receipt · 1 proved
  · tests pass`). On the right, the folder and branch, the model, the
  context window's use (`ctx 12%`), and statuses such as the permission
  mode and the sessions waiting for you.

On a narrow terminal the folder goes first, then the model; then the
evidence shortens, and the context's use goes last. The statuses always
show.

[Commands and keys](../reference/commands.md) lists every key.

## Themes

Tesota draws in `tesota-dark` or `tesota-light`, following your terminal's
background, and switches when it changes.

The themes are drawn for a `#202020` canvas (light: `#edede5`). Tesota's
terminal color schemes, in [`terminal-schemes`](../../terminal-schemes),
set that canvas and a matching ANSI palette. They're optional:

- **Windows Terminal:** copy `windows-terminal/tesota.json` to
  `%LOCALAPPDATA%\Microsoft\Windows Terminal\Fragments\Tesota\`, restart
  Windows Terminal, and choose Tesota Dark or Tesota Light as a
  profile's color scheme. Set the profile's Intense text style to
  Bold font to draw bold text bold rather than brighter.
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
