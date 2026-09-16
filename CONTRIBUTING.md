# Contributing to Tesota

Tesota is an early-stage, verification-first agent. Software development is its
first proving ground. Contributions are welcome when they advance a demonstrated
user need without weakening task authority, candidate identity, evidence
integrity or human acceptance.

## Before changing code

Read the [project identity](docs/identity.md), [architecture](docs/architecture.md),
[roadmap](docs/roadmap.md) and [development guide](docs/development.md). For a
substantial new capability, open a focused discussion or issue first so its user,
owner, effect boundary and qualification evidence are explicit.

Kiln is a historical reference, not an inherited roadmap. Follow the
[selective extraction policy](docs/decisions/005-recover-kiln-selectively.md)
when adapting its code, tests or contracts.

## Development setup

Use the versions declared in `package.json` and the dependency resolution in
`bun.lock`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` builds and type-checks the project, runs the test suites and
executes Oxlint without applying fixes. Live provider, authentication and
candidate experiments are separate commands and are not part of the offline
contribution gate.

## Change expectations

- Keep the change focused and preserve unrelated behavior.
- Put each behavior in one canonical owner and add abstractions only for current
  consumers.
- Treat public or persisted names, evidence schemas and authority rules as
  contracts.
- Add the smallest behavioral test that proves the change and its important
  failure path.
- Never make a check pass by weakening, deleting or suppressing the condition
  that detected the defect.
- Keep credentials, personal paths, provider routing and operator state out of
  source, fixtures, logs and documentation.
- Update the owning documentation when behavior, support or a consequential
  decision changes.

Do not commit generated `dist/`, dependency directories, local environment
files or retained live-run artifacts.

## Branch workflow

`main` is the stable default branch and `dev` is the protected integration
branch. Start ordinary `feature/*`, `fix/*` and documentation branches from
`dev`, then open a pull request back to `dev`. Both protected branches require
the repository checks to pass; direct pushes, force pushes and deletion are not
part of the normal workflow.

Promote an integrated increment with a pull request from `dev` to `main` and a
merge commit so the long-lived branch ancestry remains explicit. A production
hotfix starts from `main`, returns to `main` through a pull request, and is then
merged back into `dev` promptly. Delete short-lived branches after merge.

The protected [`kiln-legacy-2026-09`](https://github.com/sequelcore/tesota/tree/kiln-legacy-2026-09)
tag, not `dev`, is the canonical final Kiln development reference.

## Pull requests

Explain the user-visible outcome, important design decision, verification run
and remaining limitation. Separate measured evidence from inference. A passing
check is not human acceptance, and reviewer judgment is not execution evidence.

By contributing, you agree that your contribution is licensed under the
repository's [Apache License 2.0](LICENSE). Preserve existing copyright,
attribution and third-party notices.

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of
opening a public issue with exploit or credential details.
