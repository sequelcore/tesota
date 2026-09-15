# Tesota

**An open-source, verification-first agent.**

Tesota is designed to carry work from intent to an inspectable result, with
evidence bound to what it actually produced. Software development is its first
proving ground: an engineering task should become an exact, reviewable change
whose applicable checks and remaining limitations are clear.

> **Work that carries its evidence.**

The project is prepared for public source development under Apache-2.0. The
package remains marked `private` to prevent accidental registry publication
while its commands and evidence contracts are pre-release. No stable API or
general untrusted-workload security guarantee is offered yet.

Read [Identity and purpose](docs/identity.md) for the thesis, product vocabulary,
scope and name.

## Current state

Tesota is pre-release and intentionally narrow. Its current implementation
demonstrates parts of the software-development lifecycle rather than a general
agent.

| Available today | Boundary |
| --- | --- |
| **Tesota Shell** | Answers bounded repository questions, continues one clarification and retains supported task proposals |
| Candidate checkouts | Creates and inspects independent working copies from committed source revisions |
| Approved tasks | Executes an admitted one- or two-file documentation change with grant-derived tools |
| Verification evidence | Runs one bounded Oxlint profile with input binding and durable recovery |
| Review and adoption | Records an exact-candidate decision and can promote an accepted write set after conflict checks |
| Isolation qualification | Compares one fixed Windows command across the installed native sandbox and a pinned container policy |

Pi, Codex, Gentle AI, Oxlint and Dafny integrations have bounded experiments or
qualified slices documented in [experiments](experiments/README.md) and the
technical guides. They do not establish arbitrary task execution.

Tesota does **not** currently support general repository work, unrestricted
commands, arbitrary task manifests, general web research, untrusted workloads or
non-code workflows. The [roadmap](docs/roadmap.md) owns demonstrated progress
and remaining requirements.

## Get started

Use Bun 1.4.2 and Node 24.15.0. [package.json](package.json) owns the toolchain
selection and commands; [bun.lock](bun.lock) fixes dependency resolution.
Node runs development tools; Bun runs the compiled CLI.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun --no-env-file dist/cli.js
bun --no-env-file dist/cli.js --help
bun --no-env-file dist/cli.js task start <proposal-id>
bun --no-env-file dist/cli.js isolation qualify
bun --no-env-file dist/cli.js verify src/cli.ts
```

The argument-free command opens Tesota Shell only when all three
standard streams are attached to a terminal. In a non-interactive process it
prints help and performs no inference.

**Tesota Shell** is the surface name. **Tesota** remains the product and agent
name; "TUI" describes the terminal-rendering technology and is not part of either
name.

`check` builds, typechecks source and tests, runs tests including compiled CLI
behavior, and runs Oxlint without fixes. Repository lint enforces classic
cyclomatic complexity at maximum 20 across `src` and `tests`. These checks use
no live provider or OAuth credentials. A passing verification command covers
one file and nine lint rules; it does not establish general correctness or task
acceptance.

## Documentation map

| Read | Purpose |
| --- | --- |
| [Identity and purpose](docs/identity.md) | What Tesota is, why it exists and why it has this name |
| [Public positioning review](docs/references/public-positioning.md) | Evidence behind Tesota's position among coding and general-purpose agents |
| [Development](docs/development.md) | Setup, checks, contribution and documentation conventions |
| [Architecture](docs/architecture.md) | Implemented modules, responsibilities and boundaries |
| [Roadmap](docs/roadmap.md) | Product goal, current status and open requirements |
| [Verification](docs/verification.md) | CLI outcomes, input binding and evidence recovery |
| [Verifier strategy](docs/verifier-strategy.md) | Native-integration criteria, evidence standard and researched verifier queue |
| [Kiln extraction reference](docs/references/kiln-extraction.md) | Pinned audit, selective-reuse policy and reconciled extraction priorities |
| [Authentication](docs/authentication.md) | One-time Codex login, saved credentials and logout |
| [Candidate checkouts](docs/candidates.md) | Separate committed working copies, inspection and incomplete state |
| [Approved tasks](docs/tasks.md) | Grant-derived scope, bounded operations, evidence and promotion |
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

The package is unpublished and pre-release. [LICENSE](LICENSE) and [NOTICE](NOTICE)
retain Apache-2.0 attribution; current dependency licenses remain in their
installed packages. Historical Kiln assets and tool binaries are absent. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations and
[SECURITY.md](SECURITY.md) for private vulnerability reporting guidance.
