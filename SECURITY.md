# Security policy

Tesota is in alpha, with no stable release yet. A security fix ships in a
new prerelease of its own.

## Report a vulnerability

Report it privately through GitHub:
[report a vulnerability](https://github.com/sequelcore/tesota/security/advisories/new).
Don't open a public issue with exploit details, credentials, private
repository content or model transcripts.

Include:

- the version (`tesota --version`, or the one the receipt names) or commit,
  and your system;
- the boundary crossed, and what you expected;
- a minimal reproduction, without real credentials or private data;
- what happened, and any workaround you know.

The maintainers acknowledge and reproduce a report, find the boundary it
crosses, and coordinate the fix and its disclosure with you. While Tesota
is in alpha there's no response-time commitment and no bug bounty.

## Threat model

### The agent runs as you

Tesota is a coding agent that runs on your machine, with your user's
permissions. The commands it runs can do anything you can do. Tesota has
no sandbox. To contain it, run it in a container or a virtual machine.

### Permission modes and the floor

Every tool call passes the [permission boundary](docs/guides/permissions.md)
before it runs:

- **The mode:** read only, ask (the default) or full access. In ask mode,
  writes, commands and MCP tools ask you first.
- **Your rules,** in `~/.tesota/permissions.json`. A project's
  `.tesota/permissions.json` can only add `ask` and `deny` rules.
- **The floor,** which no mode or rule allows. It checks what a call
  names, and it checks each kind of tool differently:
  - **File tools** (`read`, `write`, `edit`, `ls`, `find`, `grep`): the
    path a call names can't be a secret (`.env` files, `~/.ssh`, and
    Tesota's own sign-ins), and `write` and `edit` write only inside the
    session's folder and its scratch folder.
  - **Shell commands:** a command is refused when its text matches a
    pattern for a destructive command (one that would destroy a disk, the
    root or a home folder) or names a secret. The floor doesn't check
    where a command writes, so in full access a command can write outside
    the session's folder and its scratch folder.
  - **Other tools** (`prove`, `check_model` and MCP server tools): the
    floor doesn't check them; the mode and your rules do.

The floor guarantees only those checks, on the text of each call. A
command can cause harm no pattern recognizes, and a later call can reach a
refused effect another way, such as a script written and then run. After a
refusal, the rest of the request asks you before every change, and the
request lists what was refused. That makes an attempt visible; it doesn't
contain it.

### Credentials

Tesota keeps its sign-ins in `~/.tesota/auth.json` and
`~/.tesota/mcp-auth.json`. On Linux and macOS, Tesota sets them readable
by your user only (mode 0600), and a folder it creates for them gets mode
0700. Windows has no
such modes, so there each file inherits its folder's permissions. API keys can also
come from your environment. Claude through your own Claude Code uses
Claude Code's sign-in, which Tesota never reads or stores. What you send a
model provider is governed by that provider's terms.

### Your own code: hooks, MCP servers and instructions

[Hooks](docs/guides/hooks.md) and [MCP servers](docs/guides/mcp.md) are
programs you configure, and they run with your permissions. A project's
hooks and MCP servers run only once you trust them in the shell, and ask
again when their commands change. `AGENTS.md`, `CLAUDE.md` and skills are
instructions to the model: a repository's files can steer the agent, so
work in repositories you trust.

### Evidence

The receipt is in scope. These are serious reports:

- evidence attached to the wrong content;
- a change reported as proved, tested or model-checked when it wasn't;
- weakened evidence that goes unreported;
- a tool call that crosses the floor;
- a credential disclosed.

### Out of scope

- Harm from commands you allowed, or that ran in full access, unless the
  floor should have refused them.
- Escaping the permission boundary by a route it doesn't claim to cover,
  as described above. The floor is not a sandbox.
- Hooks, MCP servers, skills and instructions you configured or trusted.
- Reports that need prior write access to your home folder, your settings
  or the repository.
- Prompt injection and malicious model output, unless they cross the
  floor or falsify the receipt.
- How a model provider handles the data you send it.
- A model's mistake or a weak suggestion, which is a limitation of the
  product, not a vulnerability.
