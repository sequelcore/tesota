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
your repository. The copy includes your uncommitted changes at the moment the
session's workspace is created, but not files your `.gitignore` excludes, such
as `.env` or `node_modules`. Before any shell command runs, Tesota asks:

```text
Run `bun install`? [y]es, [a]lways this session, [n]o:
```

Approved commands run with your permissions, files, network and credentials.
They are not sandboxed. `Ctrl+C` stops the current request; changes made so
far stay in the workspace.

A question that needs no changes ends with an answer. The conversation
continues, so follow-up requests keep their context.

## Review and apply

When a request leaves changes, Tesota runs your checks on exactly that
content. The first time in a repository it suggests commands from it (for
example `bun run check`); press Enter to accept, type your own separated by
`;`, or type `none`. Tesota remembers the choice for that repository.

The transcript lists the changed files and each check's outcome. The result
panel shows the full diff and check output. Then choose:

- **apply** writes the changes to your repository. A file is only written if
  your copy still matches what the agent started from, so your own edits are
  never overwritten. If any file conflicts, nothing is written.
- **reject** discards the changes. Your repository is not touched.
- **keep working** leaves the changes in the workspace so you can ask for more
  before deciding.

A passing check shows only that the command succeeded on that content. It does
not show the change does what you asked; read the diff.

## Sessions and appearance

The left column lists sessions. `Ctrl+N` starts a new one; `Alt+J` (or
`Ctrl+Tab`) selects the next. `Ctrl+W` closes the selected session and removes
its workspace and conversation. If the session has unapplied changes, the
first `Ctrl+W` warns and a second one within five seconds confirms. Stop
running work with `Ctrl+C` first. Closing the last session opens a new one. At wide sizes, `Alt+S` shows a second session
read-only; on a narrow terminal, `Alt+1`, `Alt+2` and `Alt+3` show sessions,
conversation and result panel. `Alt+,` and `Alt+.` browse earlier results.
`Ctrl+Q` closes the shell. Sessions, their workspaces and their conversations
are restored after a restart.

`tesota --theme tesota-light` or `--theme terminal` changes the appearance for
one run.

## Limits

- Exercised live only on Windows.
- Edits you make in your repository after a session starts are not visible to
  its agent.
- Changes to symbolic links and submodules cannot be applied.
- Shell commands are approved one by one but not sandboxed.
- Closing a session removes its workspace. `tesota prune` lists other
  workspaces it would remove, and `tesota prune --force` removes those that no
  session uses and that hold no unapplied changes.
