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
- **Build for a consumer that exists today.** A capability that claims to
  improve results is measured against the simplest alternative first.

## Not planned

- **A sandbox or verifier of Tesota's own.** An existing operating-system
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
- **The agent's tools:** a task list, web pages and images, background
  commands ([#521](https://github.com/sequelcore/tesota/issues/521)–[#524](https://github.com/sequelcore/tesota/issues/524)).
- **Sessions and models:** a session in a new worktree, and choosing the
  model that continues after a plan's limit
  ([#579](https://github.com/sequelcore/tesota/issues/579),
  [#597](https://github.com/sequelcore/tesota/issues/597)).
- **Fewer prerequisites:** the verification toolchain offered on first use,
  and checking models without Java
  ([#688](https://github.com/sequelcore/tesota/issues/688),
  [#738](https://github.com/sequelcore/tesota/issues/738)).
- **Working from a phone** ([#467](https://github.com/sequelcore/tesota/issues/467)),
  and open [bugs](https://github.com/sequelcore/tesota/issues?q=is%3Aissue+is%3Aopen+label%3Abug).

To propose a change, open an [issue](https://github.com/sequelcore/tesota/issues/new/choose)
first; see [CONTRIBUTING.md](CONTRIBUTING.md).
