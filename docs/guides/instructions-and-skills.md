# Instructions and skills

Tesota reads the same instruction files and skills as Codex, Claude Code,
Gemini CLI and Pi, so a project set up for one works here.

## AGENTS.md

Every session's instructions are, in order:

1. `~/.tesota/AGENTS.md`, your own, for every project;
2. each folder's `AGENTS.md` from the Git repository's root down to the
   session's folder, or its `CLAUDE.md` where it has no `AGENTS.md`.

Outside Git, only the session's own folder counts. Nothing above the
repository's root is read.

Together they keep to 32 KiB. A file that would pass it is cut, the next
ones are left out, and the instructions say so, so a very large file never
fills the model's context.

## Skills

A skill is a folder with a `SKILL.md`:

```markdown
---
name: release-notes
description: Write release notes from the merged pull requests since the last tag.
---

# Release notes

1. List the pull requests merged since the last tag...
```

Tesota looks in:

| Folder | |
| --- | --- |
| `~/.agents/skills` | Shared with Codex, Gemini CLI, OpenCode and Pi |
| `~/.tesota/skills` | Tesota's own |
| `<project>/.agents/skills` | The project's, from the session's folder up to the repository's root |

The agent sees each skill's name and description, and reads its `SKILL.md`
when it needs it. A project's skill wins over yours of the same name. A
skill without a `description` is left out.

The list keeps within 2% of the model's context window: descriptions are
shortened first, then skills left out, and the list says how many more
there are.

## Related

- [Hooks](hooks.md)
- [Configuration](../reference/configuration.md)
