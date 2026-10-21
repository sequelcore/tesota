# Architecture

Tesota is two parts in one repository: an engine that runs the agent, and
a verification layer the engine runs at the end of every run.

| Part | Folder | Owns |
| --- | --- | --- |
| **The engine**, `@tesota/core` | `packages/core` | The `tesota` command, the agent loop and its tools, sessions, permissions, compaction, workspaces, hooks, MCP, instructions and skills, and the terminal shell |
| **The verification layer** | `src` | The gate, proofs, tests, contract strength, coverage, the receipt and how they're drawn |

The engine runs on [Bun](https://bun.sh). Model access comes from
[pi-ai](https://github.com/earendil-works/pi) and the terminal from pi-tui;
MCP from pi-mcp. Tesota builds no sandbox and no verifier of its own:
proofs come from LemmaScript and Dafny, tests from your project's commands.

## A run

A run is one request, from what you asked to its end:

1. **The request is recorded.** Before the model hears of it, the request,
   where it came from and its **base** (the commit, or a snapshot outside
   Git) are written to the session and synced to disk.
2. **The agent works.** Each reply's tool calls pass the
   [permission](../guides/permissions.md) boundary and your
   [hooks](../guides/hooks.md), with each call's intent synced before it
   runs. What you type meanwhile steers the run or follows it.
3. **The run settles,** in two phases:
   - **extensions** settle first; their results add up, so none can drop
     another's message or cancel its send-back;
   - then **the verifier**, which every session must have and nothing can
     replace. It checks the change against the request and either sends
     failures back, so the run goes on, or ends it with a receipt.
4. **The run ends** as one of:
   - `completed`: only when the verifier settled it, with nothing failing
     and no input it didn't see;
   - `aborted`: you stopped it;
   - `error`: the provider failed, with the reason;
   - `incomplete`: a settle handler failed, the verifier had nothing to
     settle it with, or it was sent back 32 times;
   - `interrupted`: the process ended during the run, as a resumed session
     finds it.

The decision between those is a proved rule (`settle-rule.ts`): "the model
stopped" never counts as "the work is done".

## Sessions

A session is one JSON Lines file in `~/.tesota/sessions/<project>/`, only
ever appended to. One writer holds it, through a lock the operating system
releases when its holder ends, so a crash never leaves it locked.

Opening a session checks every line, and repairs only an interrupted last
one. A tool call the session was running when it ended is marked "no effect"
if its recorded access only reads, otherwise "outcome unknown". One it
hadn't started is marked "not run". None runs again. An interrupted shell
call's repair includes the saved end of its output and the full output's
path beside the session file.

**The request ledger.** The request, amendments and submitted answers to
the agent's questions are kept as given, in their recorded order.
When the conversation nears the context window, compaction summarizes the
older part, keeps the recent part word for word, and puts the ledger back
at the top. Verification always sees what you actually asked.

Questions use the shell's input slot and the session's permission boundary.
Effect 4 scopes each pending interaction: stopping or closing a session
releases its form before the wait ends. Submitted answers are synced before
acknowledgment; a storage failure ends the session's ability to run rather
than continuing with an answer it could not save.

## Workspaces

A session works in its **workspace**: the checkout, or, when another
session already holds it, a Git worktree of its own on branch
`tesota/<id>`. Its tools, permission floor, base, diff, checks, receipt and
MCP servers are all its own. Closing it removes the worktree only when
nothing in it changed.

## The contract

The verification layer is written against `src/contract.ts`: what it may
use of the engine, namely the session's events, tools, model access, and
what it draws through the shell. Its names and shapes come from Pi's
extension API, where Tesota's verification first ran. The engine gives it
its version, key names, the shell checks run in and its asynchronous OS
lock (`src/host.ts`), so `src/` never imports the engine.

## Why its own engine

Tesota first ran as a Pi extension. Some of what verification needs can't
be built on top of a host:

- **Settlement belongs to the host.** In Pi, a later extension's settle
  handler replaced an earlier one's verdict, an exception was only logged,
  and verification couldn't be cancelled once settling.
- **Compaction loses the request** in every harness Tesota studied, and
  verification must check against the request as given.
- **Several sessions in one shell, each in its own worktree,** need a host
  built for them.

Pi's durable runtime, `pi-durable`, has the first limit too: a run ends
when the model stops unless an `onYield` hook continues it, and only the
first hook that asks is heard.

So verification is a mandatory step of the engine's lifecycle, not an
extension. The engine's scope is what Tesota uses and nothing more:
channels, gateways and other surfaces wait for a real need.

## Compatibility

Tesota works with what other agents already read, not with an adapter per
agent: `AGENTS.md`, Agent Skills (`SKILL.md`), command hooks in Claude
Code's format, and MCP servers in the shared `mcpServers` format.

## Related

- [How verification works](verification.md)
- [Development](../development.md)
