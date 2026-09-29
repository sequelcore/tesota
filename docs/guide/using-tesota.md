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
and the advisor, which are off. `tesota roles` lists the working agent,
explorers, advisor, reviewer, refuter and fix validator with
their models, who pays for each and the model's list price, and
`tesota roles <role> <route:model>` changes one. [Choosing
models](choosing-models.md) has setups for the accounts you have and why they
work; [authentication](authentication.md) covers signing in to each route.

Explorers are off by default. `tesota roles explorer codex:gpt-6-luna` lets the agent
of sessions opened afterwards ask read-only explorers questions about the
repository with its `explore` tool: each explorer reads and searches but cannot
change files or run commands, at most three run at once and eight per
request, and each shows in the conversation with what it read and what it
cost. On Pi's routes their conversations are saved in the workspace's
`explorers` directory; on Claude Code they are not kept.
`tesota roles explorer off` turns them off again.

An **advisor** is off by default too. `tesota roles advisor claude-code:opus`
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
them. On Windows, the **WSL sandbox** runs the agent's commands in a Linux
shell inside WSL, in a distribution of Tesota's own, where they see only the
workspace, under `/mnt`, and reach only package registries. Run `tesota
setup` once to prepare it: it installs WSL if needed (an administrator prompt
and a restart), creates the distribution and restarts it when its settings
change. The first time, Tesota checks on your computer that the sandbox keeps
your files, credentials and network out of reach, and uses it only if every
check passes. `tesota sandbox` shows what each sandbox proved here and which
one is in use; `tesota sandbox use docker` (or `wsl`, `host`, `auto`) chooses
for new sessions. Inside a session, `/sandbox` opens a list including
`default`, which follows the choice for new sessions; `/sandbox docker`
switches that session alone, keeping its conversation. `tesota sandbox clean`
removes this repository's package cache and the tools the sandbox installed
for it. Docker
Sandboxes is the alternative on Windows 11, and the stronger wall for files,
since it runs a virtual machine, but it is not used for now: a program that
ignores its proxy could still open a connection, and Tesota has not yet shown
that the connection goes no further than the proxy. Choosing it runs commands
on your computer, outside the virtual machine, asking before each one, and
`tesota sandbox` says so beside it. It needs the Windows
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
the reviewer found of it: "review found it done", "review found it not done"
or "review could not decide". The plan is cleared when you apply or reject the work.

The review also checks that everything you asked for is there, not only that
the change has no defects: it shows how many of your requests are done, and a
part of a request that is confirmed missing goes back to the agent. A turn
in which the agent changes no files gets an "Answer check" too: a question
can be answered, but a reply that only says the work is done, when the code
is not there, is caught and sent back. A quick first pass, on your
`triage` model, skips the check for greetings, thanks and small talk;
`tesota roles triage off` checks every answer in full instead.

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
Run `gh pr list`? [y]es, [a]lways `gh pr …` in this repository, [n]o:
```

Approved commands run with your permissions, files, network and credentials.
They are not sandboxed. "Always" saves that rule for the repository: later
commands beginning with `gh pr` run without asking, and every other command
still asks. Tesota offers a rule only for plain commands, and never one that
starts with a shell, an interpreter such as `python` or `node`, a command
that runs another, such as `sudo` or `ssh`, or `rm`.

In the sandbox, your own programs and logins, such as `gh`, `aws` or
`docker`, are not there. When the agent needs one, it asks to run that
command on this computer instead, with its reason:

```text
Run `gh pr list` on this computer, outside the sandbox? Only your gh is signed in. [y]es, [a]lways `gh pr …` in this repository, [n]o:
``` `Esc` or `Ctrl+C` stops the current request; changes
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
reply. `tesota roles agent` sets the model for new sessions.

`/roles` chooses the model of every role, as `tesota roles` does: pick a
role, then its model, from the same kind of list. The choice holds for every
session: the judges and the first pass use it from their next check, and
the agent's role from the next new session. You can also type it, for
example `/roles triage typesafe:jev-1.13.0` or `/roles advisor off`.

## Accounts

`/accounts`, or `Alt+A`, opens the Accounts panel over the whole shell,
which fades behind it while the sessions keep working; nothing in the panel
is written to the conversation. It has three tabs, switched with `←→`, `Tab` or `1`–`3`:

- **Usage**, which `/usage` opens directly: how much each account has left
  and when it resets, as `tesota usage` shows it
  ([authentication](authentication.md#how-much-each-account-has-left)). The
  last readings show at once, faded, while each account is read again. A bar
  turns to the warning color at a quarter left and to the error color when
  nothing is.
- **Sign-ins**: each route's sign-in and the roles that use it, as `tesota
  auth status` shows it. Signing in stays in a terminal, with `tesota auth
  login <route>`.
- **Roles**: each role's model, the account it draws on, and that account's
  least-left window. Choose a role with `↑↓` and press `Enter` to change its
  model in the same list `/roles <role>` opens, so a role can move before its
  account runs out.

`r` reads everything again; `Esc` closes the panel.

## Review and apply

When a request leaves changes, Tesota runs your checks on exactly that
content. The first time in a repository it suggests commands from it (for
example `bun run check`); press Enter to accept, type your own separated by
`;`, or type `none`. Tesota remembers the choice for that repository. After a
command you may name the JUnit XML reports it writes, in paths your
`.gitignore` covers, so its failures are compared test by test:
`bun run check => test-reports/unit.xml, test-reports/workspace.xml`.

The conversation shows a review once, set apart from the agent's replies by a
rule down its left side: each changed file and each check with ✓ or ✗.
Changes to what checks the result, such as an edited test, lint or type
configuration, CI workflow, package scripts or a formal specification, are
marked ⚠: they can be a legitimate fix or a way to make checks pass, and
only you can tell which. The result panel starts with your requests behind
the changes, word for word, since everything else is measured against them.

When a check fails, Tesota runs it once more without the changes, in the same
place, and says beneath the ✗ how that ended. Only a failure the changes
brought, one that passes without them, goes back to the agent; a check that
fails either way, such as a test the sandbox cannot run, stays with you. When
the check names its reports, a test that fails only with the changes, or that
the changes added and that fails, sends it back even though the check fails
either way, and Tesota names those tests.
While the agent corrects its work, your newer edits wait for your next
request, so the review of a correction never counts them as the agent's.

Besides your checks, Tesota runs its own verifiers on the changed files. Its
Oxlint profile reports only problems the change introduced, such as an unused
variable, a new `any`, or a comment that silences a check; a change that adds
an `eslint-disable` fails. In TypeScript files with LemmaScript `//@`
annotations, LemmaScript and Dafny prove the annotated properties; this needs
Dafny installed, and without it the result says nothing was proved. The result
panel shows, for every check, what a pass establishes and what it does not.

After the checks, an independent reviewer reads your requests, the changes
and the check results, investigates the repository without being able to
change it, and reports problems. The summary groups checks, findings and
requests under **For the agent to fix**, **Needs you** and **For context**.
A reviewer that does not finish says so; it is never shown as
a clean review. Findings are advice, and a clean review does not replace
reading the change.

Before a finding can send work back to the agent, a second reviewer who has
not seen the first reviewer's reasoning tries to rule it out. Only a confirmed,
fixable problem this change introduced goes back to the agent. An unresolved
finding needs your decision; a ruled-out or pre-existing finding is context.
The result panel shows what caused a finding, how the second check ended and
its evidence. When the diff does not support a reviewer's claim about cause,
the cause is unclear and the finding stays with you.

Tesota reviews more deeply when the changes touch security- or
authority-sensitive files, change existing tests or what checks the result,
leave a verifier failing, or are large. The review then says why, and focused
reviewers for correctness, security and authority, and your repository's
`AGENTS.md` or `CLAUDE.md` rules join in; findings several of them report are
merged before you see them. Before a thorough review starts, a line says why
it is thorough, how many reviewers will work, and how long comparable reviews
have taken once three have been measured; the result then shows its time and tokens.
It asks for nothing; `Ctrl+C` stops it.

When LemmaScript proved contracts in the changes, an extra review checks
whether those contracts cover what you asked: one session restates each
proved contract without seeing your requests, and another compares that
restatement with them. A
proof can hold and still prove less than you asked, such as "denied and not
allowed is refused" when you asked that denied always wins; this reviewer
reports that gap.

Each workspace keeps an assurance journal, `assurance.jsonl` beside its
checkout: for every reviewed version, your requests, each verifier's claim and
outcome, each reviewer's findings, and whether you applied or rejected it.

When a check or review confirms a problem this change caused, Tesota sends it
back to the agent, with your requests unchanged. It then runs every
check on the corrected result, has a separate validator confirm that each
problem sent back is resolved, and reviews only what the correction changed,
so a round settles what it was sent instead of raising a fresh list: at most
two rounds, fewer if a round changes nothing. Each round shows its own review, and `Ctrl+C` stops it. Only then
does Tesota ask for your decision. What only you can decide never goes back
to the agent. The full record and the diff open beside it on a wide terminal;
`Alt+R` shows or hides them, in place of the conversation on a narrow one. The
record groups your requests, the files, the checks and the review under
headings; what each check shows and does not show, and its output, sit beneath it, the output
behind a `│` and without its colors. The diff lists the changed files with
their added and removed lines, then shows each change with line numbers,
added and removed lines tinted green and red, and code highlighted by
language.
The prompt stays visible in either view.
Then choose:

- **apply** writes the changes to your repository, only if nothing in it
  changed since the result was checked. If you edited any file, even one the
  changes do not touch, nothing is written; your next request brings your
  edits in, and the result is checked again. Tesota keeps a copy of every file
  it replaces, never overwrites a file someone changes meanwhile, and undoes
  what it wrote if it has to stop. If it cannot undo everything, it says
  "Recovery required", and `tesota recover` in that repository lists each
  file and undoes or finishes the application.
- **reject** discards the changes. Your repository is not touched.
- **keep working** leaves the changes in the workspace so you can ask for more
  before deciding.

A passing check shows only that the command succeeded on that content. It does
not show the change does what you asked; read the diff.

## Sessions and appearance

`tesota` starts a new session in the current repository or folder. Saved
sessions remain in the sidebar: select one to continue it without losing its
conversation or workspace. `tesota resume` lists saved sessions to choose
from before opening the shell; `tesota resume <session-id>` opens that exact
session. If there are no saved sessions, start with `tesota` instead. Leaving
a new session without sending a request does not keep an empty session.

In an interactive terminal, `tesota resume`, `tesota sandbox use`,
`tesota auth login`, `tesota auth logout` and `tesota roles <role>` offer
numbered, filterable choices when their target is omitted. Enter cancels;
explicit IDs and names still work in commands and scripts.

The left sidebar puts the repository and branch above its sessions. New
sessions appear first and activity never moves an existing row. Each row
keeps its precise state—such as `Running checks`, `Needs approval`,
`Reviewing`, `Needs decision`, `Unresolved`, `Unread` or `Idle`—rather than
folding every phase into working. Executing phases have a spinner; waiting and
terminal states stay still. The selected session is highlighted, operator
attention is in the warning color, and unresolved effects are in the error
color. The terminal's title, which its tabs show, names the selected session
behind a mark for all of them: `!` while any session waits for you, a spinner
while any works, otherwise the selected session's own mark. When the sessions
waiting are others, the title counts them, as in `! Budget totals · 1 waiting`;
the selection never changes on its own.

The rail shows titles and states without position numbers; `Alt+1` to `Alt+9`
remain optional shortcuts for the first nine sessions in newest-first order.

A new session shows Tesota's version, the working directory, and a palo fierro
tree above the conversation. The tree draws in five steps when there is room;
use `TESOTA_REDUCED_MOTION=1` to show it without animation. Narrow terminals
show a smaller tree or symbol. This welcome does not become part of the saved
conversation and does not replay when you restore a session.

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
new session. `/details` lists long notices, newest first, to expand or collapse;
`/details <number>` targets one directly, and `Alt+D` toggles the latest.
Your first request names it at once, and a short title written
by the `namer` role's model follows a few seconds later
(`tesota roles namer off` keeps the request as the name); `/rename <name>` names it yourself, and a name you give is kept.
`/rename` alone suggests a name from the session's latest requests; `Alt+J` selects the next and `Alt+K` the previous in the visible
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
one run. Inside the shell, `/themes` opens a list like `/roles`: type to
filter, use Up/Down to choose, Enter to switch, Tab to complete the name,
and Esc to close without switching. `/themes <name>` switches every session immediately
without restarting work. The selection lasts for this run.

| Theme | Appearance |
| --- | --- |
| `tesota-dark` (default) | Ironwood neutrals and lavender |
| `tesota-light` | Ivory and lavender |
| `vesper` | Charcoal and peach |
| `sequel` | Warm neutrals and sand |
| `automata` | Parchment and ink, with darker status colors |
| `phosphor` | Green phosphor, with subdued text and distinct status colors |
| `terminal` | Your terminal's own colors |

Themes do not change your terminal profile or its background. Use a light
terminal background with `tesota-light` or `automata`, and a dark background
with the dark themes. Messages and selections use their own paired text and
background colors; plain conversation text still uses the terminal's foreground.

## Limits

- Exercised live only on Windows.
- Changes to symbolic links and submodules cannot be applied.
- Without the sandbox, approved commands run on your computer without
  isolation.
- The sandbox gets the runtimes your repository pins
  (for example `packageManager` and `engines` in `package.json`, `.nvmrc`,
  `mise.toml`), then your `.tesota/setup.sh` or the lockfile install, all run
  inside it; only then can it download from the hosts toolchains come from.
  In the WSL sandbox, the first session with a new runtime version downloads
  it, and later sessions of the same repository reuse it. It also finds
  Java, Go, Rust, Python, Ruby and .NET from the files their projects
  already have (`pom.xml`, `go.mod`, `Cargo.toml`, `pyproject.toml`,
  `Gemfile`, `*.csproj`), with the version they name, and reaches their
  package registries; only files at the repository's root are read. In Docker
  Sandboxes, the first session with a new set of runtime versions builds them
  into a cached image, which can take a few minutes; later sessions reuse it
  and prepare in about half a minute. Restored sessions prepare when opened; new sessions prepare
  with their first request so unused sessions create no workspace. The status
  line shows preparation. Installed `node_modules` stay inside the sandbox,
  so your workspace folder shows it empty. Dev Container definitions are not read yet.
- Copies of the files an application replaced stay in
  `~/.tesota/applications/` for 30 days, or until an unfinished application
  is settled with `tesota recover`.
- Closing a session removes its workspace. `tesota prune` lists other
  workspaces it would remove, and `tesota prune --force` removes those that no
  session uses and that hold no unapplied changes.
