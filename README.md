# Tesota

**Tesota is an open-source agent for work that carries its evidence.** Ask for
a change in your repository. A coding agent makes it in a separate copy,
Tesota runs your checks and its own verifiers on exactly that result, an
independent reviewer reads it against what you asked, and you decide whether
to apply it. Nothing reaches your files until you do.

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

The agent can read, edit, create and delete files in its copy. With Docker
Sandboxes set up (`tesota setup`), its commands run on their own inside a
sandbox that sees only that copy and reaches only package registries;
otherwise every command asks for your approval first and then runs with your
permissions. See [Using Tesota](docs/guide/using-tesota.md) for the workflow
and limits. Run `bun unlink` in this checkout to remove the command.

Tesota is pre-release and has been exercised live only on Windows. A passing
check shows only that the command succeeded on the reviewed content, and a
clean review is advice; neither shows that the change does what you asked. The
[roadmap](docs/roadmap.md) owns status and priorities.

## Documentation

| Need | Read |
| --- | --- |
| The user workflow | [Using Tesota](docs/guide/using-tesota.md), [authentication](docs/guide/authentication.md) |
| How it works and why | [Design](docs/design/overview.md) |
| Decisions, in order | [Decisions](docs/decisions.md) |
| Current status and next work | [Roadmap](docs/roadmap.md) |
| What experiments established | [Findings](docs/findings.md) |
| Build, test and contribution practice | [Development](docs/development.md) |

Tesota began as a deliberate reset of Kiln; the [Kiln reference](docs/research/kiln.md)
preserves that history without making its code or roadmap part of the product.

Tesota is licensed under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and
retained third-party notices. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).
