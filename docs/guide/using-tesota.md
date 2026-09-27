# Using Tesota

Tesota is a pre-release coding agent for the terminal. You describe what you
want; it works in a separate copy of your repository; you review the changes
and check results, then apply or reject them. The [design](../design/overview.md)
explains the boundaries in detail.

## Set up

Install the Bun and Node versions pinned in [package.json](../../package.json),
then build and link this checkout:

```console
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
tesota auth login
```

Login stores a Codex credential under `~/.tesota/auth`; see
[authentication](authentication.md). `bun unlink` removes the command.

Every role uses `codex:gpt-6-luna` until you choose otherwise, except explorers
and the advisor, which are off. `tesota models` lists the working agent,
explorers, advisor, reviewer, refuter and fix validator with
their models, who pays for each and the model's list price, and
`tesota models <role> <route:model>` changes one. [Choosing
models](choosing-models.md) has setups for the accounts you have and why they
work; [authentication](authentication.md) covers signing in to each route.

Explorers are off by default. `tesota models explorer codex:gpt-6-luna` lets the agent
of sessions opened afterwards ask read-only explorers questions about the
repository with its `explore` tool: each explorer reads and searches but cannot
change files or run commands, at most three run at once and eight per
request, and each shows in the conversation with what it read and what it
cost. On Pi's routes their conversations are saved in the workspace's
`explorers` directory; on Claude Code they are not kept.
`tesota models explorer off` turns them off again.

An **advisor** is off by default too. `tesota models advisor claude-code:opus`
gives the agent of sessions opened afterwards an `advisor` tool: a stronger
model that reads the agent's conversation, has no tools, and answers with a
plan, a correction or a reason to stop, at most three times a request. The
agent decides when to consult it; you can ask for it in a request. Each
consult shows in the conversation with the agent's question.

The agent and explorers can **search the web and read pages** when you give
Tesota a search provider. Run [SearXNG](https://docs.searxng.org/) on this
computer, with its JSON format allowed in its `settings.yml`:

```yaml
use_default_settings: true
server:
  secret_key: "<a long random value>"
  limiter: false
search:
  formats: [html, json]
```

```text
docker run -d --name tesota-searxng --restart unless-stopped -p 127.0.0.1:8888:8080 -v <folder with settings.yml>:/etc/searxng searxng/searxng
```

and name it in `~/.tesota/web.json`: `{ "searxng": "http://127.0.0.1:8888" }`.
Before a page is read from a site you have not allowed, Tesota asks, as for
the sandbox's network:

```text
Read pages from docs.example.com? [y]es this session, [a]lways for this repository, [n]o:
```

Only `https` pages at public addresses are read, never a site on your own
network. The agent never sees a page itself: a separate reader with no tools
reads it and answers the agent's question, so a page cannot make the agent
act. Reviews never use the web. Sites that block automated requests, such as
npm's, and pages built with JavaScript give little text.

Commands run in a **sandbox** when one is ready, and on **this computer**
otherwise, where each one asks you first; the agent's edits always go to its
own copy of your repository, never to the repository itself until you apply
them. On Windows 11 24H2 or later, the **native sandbox** needs nothing
installed: the first time, Tesota checks on your computer, for about 20
seconds, that it keeps your files, credentials and network out of reach, and
uses it only if every check passes. In it the agent's commands run in
Windows PowerShell, and the workspace appears to them as a drive of its own,
such as `T:\`; npm works, and a command the sandbox blocks, such as
`bun install`, runs on your computer only if you approve it. `tesota sandbox`
shows what each sandbox proved here and which one is in use; `tesota sandbox
use docker` (or `native`, `host`, `auto`) chooses for new sessions, `/sandbox
docker` inside a session switches that session alone, keeping its
conversation, and `tesota sandbox clean` removes this repository's package
cache. Docker
Sandboxes is the alternative on Windows 11, and the stronger wall, since it
runs a virtual machine. It needs the Windows
Hypervisor Platform (an administrator prompt and a restart), Docker Sandboxes,
a Docker sign-in and a deny-all network policy. Run `tesota setup` to go
through them: it shows each missing step and its command, runs it when you
confirm, and checks again. It stops when Windows needs a restart; run it again
afterward. Without a terminal to ask in, it only lists what is missing.

## Work

From a Git repository with at least one commit, or from any folder of your
work, such as a folder of spreadsheets and documents:

```console
cd my-project
tesota
```

In a folder that is not a Git repository, Tesota first asks whether to work
on it, saying how many files it holds. It keeps its own record of the
folder in `~/.tesota/folders` and never adds anything to the folder itself;
nothing in the folder changes until you apply a reviewed result. Your home
directory as a whole, and the root of a drive, are refused.

Then ask for what you need:

```text
> The discount is added instead of subtracted in src/price.ts. Fix it and add a test.
```

For a request with several steps, the agent shows its plan above the prompt
and updates it as it works:

```text
 Plan · 1 of 3 done
   ✓ Find where the discount is applied · done (agent)
   ▸ Subtract the discount · in progress · will be checked: the price tests pass
   ○ Add a test for a 100% discount
```

"done (agent)" is the agent's own word, and "will be checked" is how it says
the step can be confirmed; Tesota's checks and review, not the plan, are the
evidence. After the review, each step the agent marked done also shows what
the reviewer found of it: "held in review", "not held in review" or "review
uncertain". The plan is cleared when you apply or reject the work.

The review also checks that everything you asked for is there, not only that
the change has no defects: it shows how many of your requests held, and a
part of a request that is confirmed missing goes back to the agent. A turn
in which the agent changes no files gets an "Answer check" too: a question
can be answered, but a reply that only says the work is done, when the code
is not there, is caught and sent back. A quick first pass, on your
`validator` model, skips the check for greetings, thanks and small talk.

The agent reads, searches, edits, creates and deletes files in its own copy of
your repository. In the sandbox its shell commands run without
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
continue with your newer version. On this computer, Tesota asks before
any shell command runs:

```text
Run `bun install`? [y]es, [a]lways this session, [n]o:
```

Approved commands run with your permissions, files, network and credentials.
They are not sandboxed. `Esc` or `Ctrl+C` stops the current request; changes
made so far stay in the workspace.

The conversation shows your messages on a tinted background, the agent's
replies as formatted text while it writes them, and each file it reads or
edits and each command it runs as one line; successful edits show line counts
and a short inline patch, while commands show their last few output lines.
The review still holds the complete diff. Tesota's own notes are dimmed; long
notes, such as a list of newer repository changes, show one summary line until
you press `Alt+D` to expand or collapse the latest one, even while the agent works.
At the normal request prompt, `/details` does the same; `/details 2` selects
the one before it. Warnings are colored. The line above
the input shows what the session is doing or the question it is waiting on.

A question that needs no changes ends with an answer. The conversation
continues, so follow-up requests keep their context.

A session keeps its agent's model, shown at the bottom right. `/model` opens
a list of the models: type to filter it, use ↑↓ to choose, ← → for a
reasoning level, and Enter to switch this session's agent. You can also type
the choice, for example `/model codex:gpt-6-sol@high` or
`/model claude-code:opus`. On the same
engine (every route but `claude-code` shares Pi; `claude-code` is its own)
the conversation continues. On another engine, and with `/handoff`, which
keeps the model, the agent starts a **new conversation**: it will not have
the earlier one, and Tesota says so. With your next request Tesota sends it a
brief of the session, which the conversation shows first: your requests for
the pending changes, the changes, open review findings and the agent's last
reply. `tesota models agent` sets the model for new sessions.

## Review and apply

When a request leaves changes, Tesota runs your checks on exactly that
content. The first time in a repository it suggests commands from it (for
example `bun run check`); press Enter to accept, type your own separated by
`;`, or type `none`. Tesota remembers the choice for that repository.

The conversation shows a review once: each changed file and each check with
✓ or ✗. Changes to what checks the result, such as an edited test, lint or
type configuration, CI workflow, package scripts or a formal specification,
are marked ⚠: they can be a legitimate fix or a way to make checks pass, and
only you can tell which. The result panel starts with your requests behind
the changes, word for word, since everything else is measured against them.

Besides your checks, Tesota runs its own verifiers on the changed files. Its
Oxlint profile reports only problems the change introduced, such as an unused
variable, a new `any`, or a comment that silences a check; a change that adds
an `eslint-disable` fails. In TypeScript files with LemmaScript `//@`
annotations, LemmaScript and Dafny prove the annotated properties; this needs
Dafny installed, and without it the result says nothing was proved. The result
panel shows, for every verifier, what a pass establishes and what it does not.

After the checks, an independent reviewer reads your requests, the changes
and the check results, investigates the repository without being able to
change it, and reports problems: ✗ for a defect against what you asked, ⚠
for something only you can decide, such as an ambiguous requirement or a
weakened test. A reviewer that does not finish says so; it is never shown as
a clean review. Findings are advice, and a clean review does not replace
reading the change.

Before a finding can send work back to the agent, a separate refuter, which
does not see the reviewer's reasoning, tries to disprove it. Confirmed
findings appear as above; findings it could neither confirm nor disprove are
marked `? unsettled`; refuted ones are only counted, with the refuter's
evidence in the result panel. Only confirmed defects that this change
introduced go back to the agent; problems that were already there appear as
`· already there`. Tesota checks each reviewer's "introduced" or "already
there" against the lines the change touched; when the diff does not support
it, the finding is marked `⚠ cause unclear` and left to you, with the reason
in the result panel.

Tesota reviews more deeply when the changes touch security- or
authority-sensitive files, change existing tests or what checks the result,
leave a verifier failing, or are large. The review then says why, and focused
reviewers for correctness, security and authority, and your repository's
`AGENTS.md` or `CLAUDE.md` rules join in; findings several of them report are
merged before you see them. Before a deep review starts, a line says what will
run and what comparable reviews of this repository have taken in time and
tokens, once three have been measured; the review then shows what it took.
It asks for nothing; `Ctrl+C` stops it.

When LemmaScript proved contracts in the changes, a second reviewer follows
ClaimCheck's method: one session restates each proved contract without
seeing your requests, and another compares that restatement with them. A
proof can hold and still prove less than you asked, such as "denied and not
allowed is refused" when you asked that denied always wins; this reviewer
reports that gap.

Each workspace keeps an assurance journal, `assurance.jsonl` beside its
checkout: for every reviewed version, your requests, each verifier's claim and
outcome, each reviewer's findings, and whether you applied or rejected it.

When checks fail or the reviewer finds a defect, Tesota first sends those
problems back to the agent, with your requests unchanged. It then runs every
check on the corrected result, has a separate validator confirm that each
problem sent back is resolved, and reviews only what the correction changed,
so a round settles what it was sent instead of raising a fresh list: at most
two rounds, fewer if a round changes nothing. Each round shows its own review, and `Ctrl+C` stops it. Only then
does Tesota ask for your decision. What only you can decide never goes back
to the agent. The full record and the diff open beside it on a wide terminal;
`Alt+R` shows or hides them, in place of the conversation on a narrow one. The
diff lists the changed files with their added and removed lines, then shows
each change with line numbers, added and removed lines tinted green and red,
and code highlighted by language.
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

The left sidebar puts the repository and branch above its sessions. New
sessions appear first and activity never moves an existing row. Each row
keeps its precise state—such as `Running checks`, `Needs approval`,
`Reviewing`, `Needs decision`, `Unresolved`, `Unread` or `Idle`—rather than
folding every phase into working. Executing phases have a spinner; waiting and
terminal states stay still. The selected session is highlighted, operator
attention is in the warning color, and unresolved effects are in the error
color.

The sidebar appears beside the conversation when there is room and hides
automatically on a narrow terminal. `Alt+B` hides it, or opens it over the
right side at a narrow size without taking focus from the input. `Esc` still
stops work; it does not close the sidebar. The heading over the conversation
names the selected session and, while the sidebar is hidden, also names the
repository and branch. The line below the prompt contains only execution
context and the selected session's model, such as `this computer · asks first
· claude-code:opus`, or `sandbox · …` when commands run in the sandbox.

A question above the prompt, such as a command waiting for your approval, is
always shown whole, over as many lines as it needs, and so is each command the
agent runs. Type `/` at the normal request prompt to see a command menu above
the input; the selected row is highlighted. Use arrow keys to choose and Enter
to run a command, or `/help` for commands and keyboard shortcuts. These
commands stay in the shell and do not become agent requests. `Ctrl+N` starts a
new session; `Alt+J` selects the next and `Alt+K` the previous in the visible
newest-first order, and `Alt+1` to `Alt+9` select those visible positions.
`Ctrl+Tab` also selects the next where the terminal passes it on; Windows
Terminal keeps it for its own tabs. `Ctrl+W` closes the selected session and removes
its workspace and conversation. If the session has unapplied changes, the
first `Ctrl+W` warns and a second one within five seconds confirms. Stop
running work with `Ctrl+C` first. Closing the last session opens a new one. At wide sizes, `Alt+S` shows a second session
read-only. `Alt+,` and `Alt+.` browse earlier results.
As in Claude Code and Pi, `Ctrl+C` at an idle prompt clears what you typed,
and pressed again within five seconds closes the shell; `Ctrl+D` on an empty
prompt does the same, as does `/quit`. The session is never closed this way.
Sessions, their workspaces and their conversations are restored after a
restart.

`tesota --theme tesota-light` or `--theme terminal` changes the appearance for
one run.

## Limits

- Exercised live only on Windows.
- Changes to symbolic links and submodules cannot be applied.
- Without the sandbox, approved commands run on your computer without
  isolation.
- The sandbox gets the runtimes your repository pins
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
