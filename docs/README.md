# Tesota documentation

Tesota is a coding agent whose every run ends in verification. It proves
the change where it can, tests it where it can't, and records what it
couldn't verify in a receipt.

## Get started

- [Install](get-started/install.md): installing a release, what it
  doesn't include, signing in to a model, installing from source.
- [Your first session](get-started/first-session.md): ask for a change,
  watch Tesota verify it, and read the receipt.

## Guides

- [Sessions](guides/sessions.md): the shell, several sessions at once,
  worktrees, resuming.
- [Verification](guides/verification.md): what Tesota checks, and how to
  give it more to check.
- [Receipts](guides/receipts.md): a receipt for a pull request or CI.
- [Model checking](guides/model-checking.md): check a design model and
  explore its model graph.
- [Print mode](guides/print-mode.md): one request from a script.
- [Permissions](guides/permissions.md): what the agent may do without
  asking.
- [Models](guides/models.md): signing in, choosing a model, thinking.
- [Instructions and skills](guides/instructions-and-skills.md):
  `AGENTS.md` and skills.
- [Hooks](guides/hooks.md): your own commands before and after the agent's
  tool calls.
- [MCP servers](guides/mcp.md): tools from MCP servers.
- [Subagents](guides/subagents.md): the agent hands a task to another
  agent with its own context, and gets its report and receipt.
- [The terminal](guides/terminal.md): display modes, themes, terminal color
  schemes and Windows.

## Concepts

- [Architecture](concepts/architecture.md): the engine, the verification
  layer, sessions, and why Tesota has its own engine.
- [How verification works](concepts/verification.md): checks, evidence,
  standing and verification limits.

## Reference

- [Commands and keys](reference/commands.md)
- [Configuration](reference/configuration.md): every file Tesota reads.
- [Receipt v2](receipt-v2.md): the receipt's format.
- [Proved rules](reference/proved-rules.md): every rule in `formal:check`.
- [Glossary](reference/glossary.md): terms used in the docs and receipts.

## Project

- [Roadmap](../ROADMAP.md)
- [Development](development.md): building, testing and proving Tesota.
- [Contributing](../CONTRIBUTING.md) and [Security](../SECURITY.md)
