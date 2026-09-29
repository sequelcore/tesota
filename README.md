# Tesota

**Tesota is an open-source, verification-first agent for work that carries
its evidence.** Ask for a change in your repository. A coding agent makes it
in a separate copy, Tesota runs your checks and its own verifiers on exactly
that result, an independent reviewer reads it against what you asked, and
you decide whether to apply it. Nothing reaches your files until you do.
Software development is its first proving ground.

## The name

Tesota takes its name from *Olneya tesota*, the desert ironwood, *palo
fierro* in Spanish: a tree of the Sonoran Desert whose wood is dense enough
to sink in water, and under whose shelter other plants take root. The name stands for a durable foundation that supports growth.

It is also a change of approach. Tesota replaced Kiln, whose scope and
infrastructure grew faster than a workflow reliable enough to use every day.
Tesota builds in the other order: a foundation that works first, then each
capability once there is evidence it helps. The
[design overview](docs/design/overview.md#name-and-identity) has the full
identity, and the [Kiln reference](docs/research/kiln.md) preserves that
history.

## Try it

This package is not published. From a source checkout, use the Bun and Node
versions in [package.json](package.json):

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun link
tesota auth login
```

`tesota auth login` lets you choose a route; `tesota auth login codex` signs
in with a ChatGPT plan. Without one, Tesota can use
Claude Code, an Anthropic API key, OpenCode, or OpenRouter, whose free models
need no payment; [choosing models](docs/guide/choosing-models.md) shows the
setup for each.

Then, in the repository you want to work on:

```sh
cd my-project
tesota
```

The agent can read, edit, create and delete files in its copy. On Windows 11
24H2 or later, its commands run on their own in Tesota's native sandbox, once
Tesota has checked on your computer that the sandbox holds; Docker
Sandboxes' virtual machine asks before each command for now, while its
network allowlist is checked again. A sandbox sees only that copy and reaches
only package registries; without one, every command asks for your approval first and then runs with your
permissions. `tesota sandbox` shows and chooses where they run. See [Using Tesota](docs/guide/using-tesota.md) for the workflow
and limits. Run `bun unlink` in this checkout to remove the command.

Tesota is pre-release and has been exercised live only on Windows. A passing
check shows only that the command succeeded on the reviewed content, and a
clean review is advice; neither shows that the change does what you asked. The
[roadmap](docs/roadmap.md) owns status and priorities.

## Documentation

| Need | Read |
| --- | --- |
| The user workflow | [Using Tesota](docs/guide/using-tesota.md), [authentication](docs/guide/authentication.md), [choosing models](docs/guide/choosing-models.md) |
| How it works and why | [Design](docs/design/overview.md) |
| Decisions, in order | [Decisions](docs/decisions.md) |
| Current status and next work | [Roadmap](docs/roadmap.md) |
| What experiments established | [Findings](docs/findings.md) |
| Build, test and contribution practice | [Development](docs/development.md) |

Tesota is licensed under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and
retained third-party notices. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).
