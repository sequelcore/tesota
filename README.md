# Tesota

**Tesota is an open-source agent for work that carries its evidence.** Ask for
a change in your repository. A coding agent makes it in a separate copy, Tesota
runs your checks on exactly that result, and you read the diff and decide
whether to apply it. Nothing reaches your files until you do.

## Try it

This package is not published. From a source checkout, use the Bun and Node
versions in [package.json](package.json):

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun link
tesota auth login
```

Then, in the repository you want to work on:

```sh
cd my-project
tesota
```

The agent can read, edit, create and delete files in its copy. Every shell
command asks for your approval first and then runs with your permissions; it is
not sandboxed. See [Using Tesota](docs/using-tesota.md) for the workflow and
limits. Run `bun unlink` in this checkout to remove the command.

Tesota is pre-release and has been exercised live only on Windows. A passing
check shows only that the command succeeded on the reviewed content, not that
the change does what you asked. The [roadmap](docs/roadmap.md) owns status and
priorities.

## Documentation

| Need | Read |
| --- | --- |
| Complete user workflow | [Using Tesota](docs/using-tesota.md) |
| Current status and next work | [Roadmap](docs/roadmap.md) |
| Purpose, design, checks and boundaries | [Architecture](docs/architecture.md) |
| What earlier experiments established | [Findings](docs/findings.md) |
| Build, test and contribution guidance | [Development](docs/development.md) |
| Consequential decisions | [docs/decisions](docs/decisions/) |

Tesota began as a deliberate reset of Kiln. The
[reconstruction decision](docs/decisions/001-start-tesota.md) and
[Kiln reference](docs/references/kiln.md) preserve that history without making
its code or roadmap part of the current product.

Tesota is licensed under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and
retained third-party notices. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).
