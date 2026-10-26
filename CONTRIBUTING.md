# Contributing to Tesota

Tesota is in alpha. Contributions are welcome when they serve a real need
without weakening the evidence a receipt reports.

## Report an issue

[Open an issue](https://github.com/sequelcore/tesota/issues/new/choose)
with the bug report or feature request form. For a bug, include the
version (`tesota --version`, or the one the receipt names), your system,
terminal and model, and the steps. Remove private code and secrets first.

Report a security vulnerability privately, as [SECURITY.md](SECURITY.md)
says, never in a public issue.

## Propose a change

1. For a new capability, open an issue first, saying who needs it and how
   its effect will be shown. Read the [roadmap](ROADMAP.md) for what's
   planned and what isn't.
2. Branch from `dev`. [Development](docs/development.md) covers building,
   checking and proving Tesota from source, and the
   [branch rules](docs/development.md#branches).
3. Open a pull request against `dev`. Its template asks what changed and
   why, how you verified it, and which checks ran.

A good change:

- is focused, and leaves unrelated behavior alone;
- puts each behavior in one owner, and adds an abstraction only for a
  consumer that exists;
- treats saved names, such as the receipt's fields and session entries, as
  contracts;
- adds the smallest test that proves it;
- never makes a check pass by weakening, deleting or skipping what found
  the defect;
- keeps credentials and personal paths out of code, tests, logs and docs;
- updates the page that owns what changed.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org):
a type (`feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `ci`, `chore`),
an optional scope, and an imperative subject under 72 characters, such as
`fix(shell): navigate every question row with arrows`. The body says why.
A pull request's title follows the same form.

## License

By contributing, you license your contribution under the
[Apache License 2.0](LICENSE). Keep existing copyright, attribution and
third-party notices, and add one to [NOTICE](NOTICE) for any third-party
code a change bundles or adapts.
