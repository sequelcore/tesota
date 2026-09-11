# Tesota

Tesota is a local coding agent in development, built around verifiable changes
and human control. It aims to help developers take a task from intent to a
reviewable result: understand the code, make a bounded change, check it, and
show the evidence needed to decide whether to accept it.

Its first proving ground is its own development. Tesota should be able to help
build its next version while keeping the current usable version available.
The name comes from desert ironwood, *Olneya tesota*: the project's image of a
durable foundation that supports growth. Read [Identity and purpose](docs/identity.md)
for the name's origin, intended experience and measure of success.

## Current state

Today it provides a CLI with one bounded Oxlint check, input binding, and durable
verification evidence recovery. Separate Pi experiments exercise synthetic agent
behavior, live Codex authentication, one fixed verification action, and an
isolated candidate correction with a review diff. **Tesota does not yet execute
general repository tasks.** It can run two deliberately fixed tasks as development
evidence. It can also [create and inspect independent candidate
checkouts](docs/candidates.md) from committed source revisions.
The first [scoped repository task](docs/tasks.md) can correct one documentation
paragraph through a bounded model attempt and retain its checks and diff.
Its offline review commands can record a separate operator decision for the
exact reviewed candidate state.
An explicit promotion command can apply the accepted paragraph while refusing
conflicting source changes.
See the [roadmap](docs/roadmap.md) for demonstrated progress and remaining work.

## Get started

Use Bun 1.4.2 and Node 24.15.0. [package.json](package.json) owns the toolchain
selection and commands; [bun.lock](bun.lock) fixes dependency resolution.
Node runs development tools; Bun runs the compiled CLI.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun --no-env-file dist/cli.js --help
bun --no-env-file dist/cli.js verify src/cli.ts
```

`check` builds, typechecks source and tests, runs tests including compiled CLI
behavior, and runs Oxlint without fixes. These checks use no live provider or
OAuth credentials. A passing verification command covers one file and two lint
rules; it does not establish general correctness or task acceptance.

## Documentation

| Read | Purpose |
| --- | --- |
| [Identity and purpose](docs/identity.md) | What Tesota is, why it exists and why it has this name |
| [Development](docs/development.md) | Setup, checks, contribution and documentation conventions |
| [Architecture](docs/architecture.md) | Implemented modules, responsibilities and boundaries |
| [Roadmap](docs/roadmap.md) | Product goal, current status and open requirements |
| [Verification](docs/verification.md) | CLI outcomes, input binding and evidence recovery |
| [Authentication](docs/authentication.md) | One-time Codex login, saved credentials and logout |
| [Candidate checkouts](docs/candidates.md) | Separate committed working copies, inspection and incomplete state |
| [Scoped task](docs/tasks.md) | Permitted file operations and the first repository task's checks |
| [Experiments](experiments/README.md) | Pi and Codex guides, recorded outcomes and limitations |
| [Project history](docs/history/README.md) | Bootstrap provenance and toolchain validation |

## Origin and license

The [reconstruction decision](docs/decisions/001-start-tesota.md) explains why
development moved to a smaller implementation. [Kiln remains a reference](docs/references/kiln.md)
for selected code, tests and lessons. Its roadmap does not define Tesota's scope.

The historical source is `4257ee9fce034cfe8e50dce3dbe3afb12f468094`, not a
verified functional baseline. The [bootstrap inventory](docs/history/bootstrap-inventory.json)
records inherited file dispositions. No Kiln implementation package was ported.

The package is private and provisional. [LICENSE](LICENSE) and [NOTICE](NOTICE)
retain Apache-2.0 attribution; current dependency licenses remain in their
installed packages. Historical Kiln assets and tool binaries are absent.
Public branding and distribution remain undecided.
