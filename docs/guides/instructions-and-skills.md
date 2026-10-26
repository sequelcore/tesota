# Instructions and skills

Tesota reads instructions from `AGENTS.md` files, or `CLAUDE.md` where a
folder has no `AGENTS.md`, and skills from `.agents/skills` folders and
`~/.tesota/skills`. It
doesn't read `.claude/skills`, `.claude/agents` or any other tool's
settings: a skill kept only in `.claude/skills` needs a copy in
`.agents/skills` to load.

## AGENTS.md

Every session's instructions are, in order:

1. `~/.agents/AGENTS.md`, yours, shared with other agents;
2. `~/.tesota/AGENTS.md`, yours, for Tesota alone;
3. each folder's `AGENTS.md` from the Git repository's root down to the
   session's folder, or its `CLAUDE.md` where it has no `AGENTS.md`.

`~/.agents/AGENTS.md` is Tesota's convention, kept beside `~/.agents/skills`;
AGENTS.md itself names no place for your own file, and Tesota reads no other
tool's folder. A file reached again through a link, such as a
`~/.tesota/AGENTS.md` that links to `~/.agents/AGENTS.md`, is read once,
where it first comes. Each file is named by its path in the instructions.

Outside Git, only the session's own folder counts. Nothing above the
repository's root is read.

Together they keep to 32,768 characters. A file that would pass that is
cut, the next ones are left out, and the instructions say so, so a very
large file never fills the model's context.

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
| `~/.agents/skills` | Yours, in the folder other agents can share |
| `~/.tesota/skills` | Tesota's own |
| `<project>/.agents/skills` | The project's, from the session's folder up to the repository's root |

The agent sees each skill's name and description, and reads its `SKILL.md`
when it needs it. A project's skill wins over yours of the same name. A
skill without a `description` is left out.

The list keeps within 2% of the model's context window: descriptions are
shortened first, then skills left out, and the list says how many more
there are.

### Starting a skill by name

Type `/` and the skill's name at the start of a message, in the shell or in
`tesota -p`, to run it on the rest of the line:

```text
/release-notes since v0.4
```

The skills appear in the shell's `/` menu beside its commands; a command
wins over a skill of the same name. Sent while the agent works, a skill
waits as a follow-up until the run ends, rather than steering it. Like
other [pending messages](../reference/commands.md#keys), it shows above
the input and can be returned there to edit or withdraw. The agent gets
the skill's `SKILL.md` with your words in place, as Claude Code places
them:

| In `SKILL.md` | Becomes |
| --- | --- |
| `$ARGUMENTS` | Everything after the name, as you typed it |
| `$ARGUMENTS[0]`, `$0`; `$ARGUMENTS[1]`, `$1`… | Each word, from 0; quotes keep words together. One you didn't give stays as written |
| `\$1` | A literal `$1` |

When nothing in `SKILL.md` takes your words, they're added at its end as
`ARGUMENTS: …`. Your request is the line you typed: verification and the
receipt read it, never the skill's text.

Two fields say who may start a skill:

| Field | |
| --- | --- |
| `disable-model-invocation: true` | Only you, by name: the agent's list leaves it out |
| `user-invocable: false` | Only the agent: the `/` menu leaves it out, and `/name` doesn't start it |

## Related

- [Hooks](hooks.md)
- [Configuration](../reference/configuration.md)
