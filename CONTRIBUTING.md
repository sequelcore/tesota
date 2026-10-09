# Contributing to Tesota

Tesota is a pre-release verification layer for coding agents. Contributions
are welcome when they advance a demonstrated user need without weakening
evidence integrity or human acceptance.

## Before changing code

Read the [roadmap](docs/roadmap.md) and the
[development guide](docs/development.md). For a
substantial new capability, open a focused discussion or issue first so its user,
owner, effect boundary and qualification evidence are explicit.

## Development setup

Use the versions declared in `package.json` and the dependency resolution in
`bun.lock`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` builds and type-checks the project, runs the tests and
executes Oxlint without applying fixes. The proofs are a separate command,
`bun run formal:check`, which needs Dafny (`mise install`). It is not part of
the offline contribution gate, but CI runs it after the check, so a change that
breaks a proof fails CI.

## Change expectations

- Keep the change focused and preserve unrelated behavior.
- Put each behavior in one canonical owner and add abstractions only for current
  consumers.
- Treat public or persisted names and evidence schemas as contracts.
- Add the smallest behavioral test that proves the change and its important
  failure path.
- Never make a check pass by weakening, deleting or suppressing the condition
  that detected the defect.
- Keep credentials, personal paths and operator state out of
  source, fixtures, logs and documentation.
- Update the owning documentation when behavior, support or a consequential
  decision changes.

Do not commit generated `dist/`, dependency directories or local environment
files.

## Branch workflow

Start from `dev` and follow the [branch rules](docs/development.md#branches).

## Pull requests

Explain the user-visible outcome, important design decision, verification run
and remaining limitation. Separate measured evidence from inference. A passing
check is not human acceptance, and reviewer judgment is not execution evidence.

By contributing, you agree that your contribution is licensed under the
repository's [Apache License 2.0](LICENSE). Preserve existing copyright,
attribution and third-party notices.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue with exploit or credential details.
