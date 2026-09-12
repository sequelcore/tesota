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
isolated candidate correction with a review diff. Tesota now executes
application-registered, bounded tasks through one shared engine, including a two-file task.
It does not accept arbitrary task manifests or general repository work. It can
also [create and inspect independent candidate
checkouts](docs/candidates.md) from committed source revisions.
The [registered repository tasks](docs/tasks.md) declare their requirement,
scope and oracle before a bounded model attempt and retain their checks and diff.
An explicit recovery command can retry a failed or interrupted registered task
from the same committed baseline in a clean successor candidate without copying
partial work or prior authority.
Its offline review commands can record a separate operator decision for the
exact reviewed candidate state.
An explicit promotion command can apply an accepted registered write set while
refusing conflicting source changes before the first source write.
The new [`task propose`](docs/proposals.md) command accepts an ordinary-language
goal and uses bounded, read-only discovery over committed Tesota files to retain
a non-authoritative proposed scope. It creates no candidate and cannot execute
the proposal. In an interactive terminal, running `tesota` now opens the first
Tesota-owned conversational shell. One read-only turn can answer a repository
question, request a necessary clarification or retain a task proposal. None of
those results grants execution authority, and the shell does not yet approve or
execute proposals.
See the [roadmap](docs/roadmap.md) for demonstrated progress and remaining work.
The proposed [natural-language task experience](docs/decisions/003-natural-language-task-experience.md)
defines how later approval and execution will remain separate from this proposal.

## Get started

Use Bun 1.4.2 and Node 24.15.0. [package.json](package.json) owns the toolchain
selection and commands; [bun.lock](bun.lock) fixes dependency resolution.
Node runs development tools; Bun runs the compiled CLI.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun --no-env-file dist/cli.js
bun --no-env-file dist/cli.js --help
bun --no-env-file dist/cli.js verify src/cli.ts
```

The argument-free command opens the conversational shell only when all three
standard streams are attached to a terminal. In a non-interactive process it
prints help and performs no inference.

`check` builds, typechecks source and tests, runs tests including compiled CLI
behavior, and runs Oxlint without fixes. Repository lint enforces classic
cyclomatic complexity at maximum 20 across `src` and `tests`. These checks use
no live provider or OAuth credentials. A passing verification command covers
one file and nine lint rules; it does not establish general correctness or task
acceptance.

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
| [Registered tasks](docs/tasks.md) | Task contracts, bounded operations, recovery and checks |
| [Task proposals](docs/proposals.md) | Read-only conversational discovery and non-authoritative proposal records |
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
