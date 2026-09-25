# Using Tesota

Tesota is a pre-release coding agent for the terminal. You describe what you
want; it works in a separate copy of your repository; you review the changes
and check results, then apply or reject them. [Architecture](architecture.md)
explains the boundaries in detail.

## Set up

Install the Bun and Node versions pinned in [package.json](../package.json),
then build and link this checkout:

```console
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
tesota auth login
```

Login stores a Codex credential under `~/.tesota/auth`; see
[authentication](authentication.md). `bun unlink` removes the command.

Sessions are **autonomous** when Docker Sandboxes is set up, and
**supervised** otherwise. On Windows 11, autonomous sessions need the Windows
Hypervisor Platform (an administrator prompt and a restart), Docker Sandboxes,
a Docker sign-in and a deny-all network policy. Run `tesota setup` to go
through them: it shows each missing step and its command, runs it when you
confirm, and checks again. It stops when Windows needs a restart; run it again
afterward. Without a terminal to ask in, it only lists what is missing.

## Work

From a Git repository with at least one commit:

```console
cd my-project
tesota
```

Then ask for what you need:

```text
> The discount is added instead of subtracted in src/price.ts. Fix it and add a test.
```

The agent reads, searches, edits, creates and deletes files in its own copy of
your repository. In an autonomous session its shell commands run without
asking, inside a sandbox that sees only that copy and reaches only package
registries. If a command tries to reach another host, Tesota asks you:

```text
The sandbox refused network access to api.github.com:443. Allow it? [y]es this session, [a]lways for this repository, [n]o:
```

The agent is told your answer and reruns the command if you allowed it. The
copy includes your uncommitted changes, but not files your
`.gitignore` excludes, such as `.env` or `node_modules`. Before each request,
Tesota brings in anything you changed since, and keeps the agent's pending
changes on top. If you and the agent changed the same lines, Tesota leaves the
copy as it was and names the files; apply or reject the pending changes to
continue with your newer version. In a supervised session, Tesota asks before
any shell command runs:

```text
Run `bun install`? [y]es, [a]lways this session, [n]o:
```

Approved commands run with your permissions, files, network and credentials.
They are not sandboxed. `Ctrl+C` stops the current request; changes made so
far stay in the workspace.

The conversation shows your messages on a tinted background, the agent's
replies as formatted text while it writes them, and each file it reads or
edits and each command it runs as one line; a command also shows its last
few output lines. Tesota's own notes, such as preparation or newer changes
from your repository, are dimmed, and warnings are colored. The line above
the input shows what the session is doing or the question it is waiting on.

A question that needs no changes ends with an answer. The conversation
continues, so follow-up requests keep their context.

## Review and apply

When a request leaves changes, Tesota runs your checks on exactly that
content. The first time in a repository it suggests commands from it (for
example `bun run check`); press Enter to accept, type your own separated by
`;`, or type `none`. Tesota remembers the choice for that repository.

The conversation shows a review once: each changed file and each check with
✓ or ✗. The full diff and check output open beside it on a wide terminal;
`Alt+R` shows or hides them, in place of the conversation on a narrow one.
The prompt stays visible in either view.
Then choose:

- **apply** writes the changes to your repository. A file is only written if
  your copy still matches what the agent started from, so your own edits are
  never overwritten. If any file conflicts, nothing is written.
- **reject** discards the changes. Your repository is not touched.
- **keep working** leaves the changes in the workspace so you can ask for more
  before deciding.

A passing check shows only that the command succeeded on that content. It does
not show the change does what you asked; read the diff.

## Sessions and appearance

The left sidebar names the repository and shows each session's state, such as
`needs you`, `working`, or `idle`. It hides automatically on narrow terminals;
`Alt+B` hides or shows it when there is room. The line below the prompt shows
the mode, repository and selected session. `Ctrl+N` starts a new session;
`Alt+J` (or `Ctrl+Tab`) selects the next. `Ctrl+W` closes the selected session and removes
its workspace and conversation. If the session has unapplied changes, the
first `Ctrl+W` warns and a second one within five seconds confirms. Stop
running work with `Ctrl+C` first. Closing the last session opens a new one. At wide sizes, `Alt+S` shows a second session
read-only. `Alt+,` and `Alt+.` browse earlier results.
`Ctrl+Q` closes the shell. Sessions, their workspaces and their conversations
are restored after a restart.

`tesota --theme tesota-light` or `--theme terminal` changes the appearance for
one run.

## Limits

- Exercised live only on Windows.
- Changes to symbolic links and submodules cannot be applied.
- Supervised sessions run approved commands on your computer without
  isolation.
- An autonomous session's sandbox gets the runtimes your repository pins
  (for example `packageManager` and `engines` in `package.json`, `.nvmrc`,
  `mise.toml`), then your `.tesota/setup.sh` or the lockfile install. The first
  session with a new set of runtime versions builds them into a cached image,
  which can take a few minutes; later sessions reuse it and prepare in about
  half a minute. Preparation starts as soon as a session opens, and the status
  line shows it, so it is often done before you send your first request. Installed `node_modules` stay inside the sandbox, so your
  workspace folder shows it empty. Dev Container definitions are not read yet.
- Closing a session removes its workspace. `tesota prune` lists other
  workspaces it would remove, and `tesota prune --force` removes those that no
  session uses and that hold no unapplied changes.
