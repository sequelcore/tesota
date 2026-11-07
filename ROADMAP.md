# Roadmap

Direction, without dates. The plan lives in
[GitHub issues](https://github.com/sequelcore/tesota/issues).

## Principles

- **Check results, not actions.** Permissions limit what the agent may do;
  they aren't verification.
- **Evidence is separate from judgment.** A model's opinion is labeled as
  one, and accepting a change is always yours.
- **Say what wasn't verified.** A passing check never hides what nothing
  checked.
- **Verification is part of every run.** Nothing skips it, and an
  unverified run never ends as verified.
- **Reuse existing tools:** LemmaScript and Dafny, TLC, your project's
  tests, pi-ai and pi-tui.
- **Verifiers are dependencies.** Tesota contains no verifier. Where no
  existing one fits, such as one that runs without Java or .NET, Sequel
  may maintain one in its own package, held to the same comparison against
  a reference as any verifier Tesota adopts.
- **Build for a consumer that exists today.** A capability that claims to
  improve results is measured against the simplest alternative first.

## Not planned

- **A sandbox of Tesota's own.** An existing operating-system
  sandbox will be used when automated runs need one.
- **Surfaces beyond the terminal,** such as a GUI or an ACP server, until a
  real client exists. A static file your browser opens counts as terminal
  work.
- **Model access of its own.** Providers come from pi-ai.
- **A plan mode.** Ask for a plan in your words; read only
  [permissions](docs/guides/permissions.md) keep anything from changing.

## Focus areas

- **Evidence per changed path:** which tests exercised each file, run by
  its workspace's runner, and what a run that changes nothing says
  ([#669](https://github.com/sequelcore/tesota/issues/669),
  [#674](https://github.com/sequelcore/tesota/issues/674),
  [#536](https://github.com/sequelcore/tesota/issues/536)).
- **Findings that become checks:** a reviewer that proposes checks you
  approve, not verdicts ([#397](https://github.com/sequelcore/tesota/issues/397),
  [#429](https://github.com/sequelcore/tesota/issues/429)).
- **Receipts you can share:** a page generated from its evidence, and each
  path's owners ([#661](https://github.com/sequelcore/tesota/issues/661),
  [#533](https://github.com/sequelcore/tesota/issues/533)).
- **Cases a request leaves open:** found before the work, from inputs
  where readings of the request disagree, and measured first
  ([#796](https://github.com/sequelcore/tesota/issues/796)).
- **Background commands that stop before verification**
  ([#524](https://github.com/sequelcore/tesota/issues/524)).
- **Fewer prerequisites:** the verification toolchain offered on first use
  ([#688](https://github.com/sequelcore/tesota/issues/688)).
- Open [bugs](https://github.com/sequelcore/tesota/issues?q=is%3Aissue+is%3Aopen+label%3Abug).

The engine gets what verification needs and fixes to its bugs. Features
that only match other coding agents wait: a task list, web pages and images
([#521](https://github.com/sequelcore/tesota/issues/521)–[#523](https://github.com/sequelcore/tesota/issues/523)),
a session in a new worktree and choosing the model after a plan's limit
([#579](https://github.com/sequelcore/tesota/issues/579),
[#597](https://github.com/sequelcore/tesota/issues/597)), working from a
phone ([#467](https://github.com/sequelcore/tesota/issues/467)), a terminal
theme that follows yours ([#748](https://github.com/sequelcore/tesota/issues/748))
and a Roles tab ([#672](https://github.com/sequelcore/tesota/issues/672)).

To propose a change, open an [issue](https://github.com/sequelcore/tesota/issues/new/choose)
first; see [CONTRIBUTING.md](CONTRIBUTING.md).
