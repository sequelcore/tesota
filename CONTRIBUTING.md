# Contributing to Tesota

Tesota is pre-release. Contributions are welcome when they serve a real
need without weakening the evidence or a person's acceptance.

## Before you start

Read the [roadmap](ROADMAP.md) and [development](docs/development.md). For
a new capability, open an [issue](https://github.com/sequelcore/tesota/issues/new)
first, saying who needs it and how its effect will be shown.

## Set up

```sh
bun install --frozen-lockfile --ignore-scripts
bun run vendor
bun run check
```

`bun run check` type-checks, runs the tests and lints, without fixing
anything, and runs the engine's tests and performance budgets. The proofs
are `bun run formal:check`, which needs Dafny (`mise install`); CI runs
both, so a change that breaks a proof fails CI.

## A good change

- Is focused, and leaves unrelated behavior alone.
- Puts each behavior in one owner, and adds an abstraction only for a
  consumer that exists.
- Treats public and saved names, such as the receipt's fields and session
  entries, as contracts.
- Adds the smallest test that proves it, and its important failure.
- Never makes a check pass by weakening, deleting or silencing what found
  the defect.
- Keeps credentials, personal paths and your own state out of code, tests,
  logs and docs.
- Updates the page that owns what changed.

## Branches and pull requests

Start from `dev` and follow the [branch rules](docs/development.md#branches).
A pull request says what changes for the user, the decision behind it, the
checks that ran and what's left. Keep measured evidence apart from
inference: a passing check isn't acceptance, and a reviewer's judgment isn't
evidence it ran.

By contributing, you license your contribution under the repository's
[Apache License 2.0](LICENSE). Preserve existing copyright, attribution and
third-party notices.

Report security issues as [SECURITY.md](SECURITY.md) says, never in a
public issue.
