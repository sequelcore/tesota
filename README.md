# Tesota

**Tesota makes your coding agent show evidence that its change does what you
asked:** proved where it can, tested where it can't, and it says plainly what
it couldn't verify. It ships as a [Pi](https://pi.dev) package and a `tesota`
command that opens Pi with it.

Tesota is being rebuilt from a full coding agent into this verification
layer. Today the package loads into Pi and adds no verification yet; the
[roadmap](docs/roadmap.md) lists what comes next. The earlier agent remains
in Git history.

## The name

Tesota takes its name from *Olneya tesota*, the desert ironwood, *palo
fierro* in Spanish: a tree of the Sonoran Desert whose wood is dense enough
to sink in water, and under whose shelter other plants take root. The name
stands for a durable foundation that supports growth.

## Try it

This package is not published. From a source checkout, use the Bun and Node
versions in [package.json](package.json):

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun link
```

Tesota runs inside Pi 1.1.0 or later, installed beside it; in a checkout,
`bun install` provides one. `tesota` opens Pi with Tesota loaded and passes
every argument to Pi, so `tesota -p "<request>"` runs one request. Run
`bun unlink` in this checkout to remove the command.

## Documentation

| Need | Read |
| --- | --- |
| Current status and next work | [Roadmap](docs/roadmap.md) |
| Build, test and contribution practice | [Development](docs/development.md) |

Tesota is licensed under [Apache-2.0](LICENSE). Preserve [NOTICE](NOTICE) and
retained third-party notices. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).
