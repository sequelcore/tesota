# Tesota

**Tesota is an open-source agent for work that carries its evidence.** Give it
a task, inspect what it did and what its checks establish, and decide what to
accept. It is being rebuilt around a general coding loop
([decision 013](docs/decisions/013-general-agent-loop-first.md)). Today it helps you
inspect a repository and attempt a bounded TypeScript change, then shows the
result, applicable checks and remaining unknowns before you decide whether to
apply it.

The current interface is a local terminal workspace with saved conversations.
It can answer related
questions about a committed repository, ask for clarification and propose a
supported change. After you approve the scope, it works in an independent
checkout, runs fixed checks and presents the diff for review. Acceptance and
application are separate steps.

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

The supported change path currently requires Windows, Git and, for the TypeScript
profile, a matching dependency installation in the target repository. The shell
defaults to trusted local checks, which can access host files, network and
credentials. Choose `tesota --execution docker-contained` for the protected
container route; that choice requires Docker Desktop and the pinned image already
available locally. Tesota does not install dependencies or pull images during a task. See
[Using Tesota](docs/using-tesota.md) for setup, task scope, review and recovery.
Run `bun unlink` in this checkout to remove the development command.

## Scope

The source-only task can change one or two existing non-test TypeScript files
under `src/` and run a fixed no-emit typecheck. A separate source-and-test
task can change one existing TypeScript source file and one existing regression
test. It requires the targeted Node test and can also require the fixed
typecheck when both profiles are eligible and selected before approval. Both
task shapes require explicit approval and human review.

Tesota does not currently handle arbitrary repository changes, new or deleted
files, model-selected shell commands, dependency changes or interrupted-task
resume. A passing check establishes only its stated claim for the bound result;
it does not establish that the requested behavior is correct. The
[roadmap](docs/roadmap.md) owns current status and priorities.

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
