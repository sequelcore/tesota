# Roadmap

Tesota is a coding agent that checks its code, challenges its specs, and
flags where they may miss your request. Every run ends with a receipt:
what was proved, tested and model-checked, what it couldn't verify, and,
kept apart, a model's opinion of whether the checks match the request. This page
lists the principles it's built on, what it won't do, and the areas being
worked on. The plan lives in [GitHub issues](https://github.com/sequelcore/tesota/issues);
this page sets direction, without dates.

## Principles

- **Check results, not actions.** Tesota checks what the change does.
  Permissions limit what the agent may do; they aren't verification.
- **Evidence is separate from judgment.** A proof or a passing test is
  evidence. A model's opinion is labeled as one, and accepting a change is
  always yours.
- **Say what wasn't verified.** A passing check never hides what nothing
  checked.
- **Verification is part of every run.** No setting or extension skips it,
  and a run that wasn't verified never ends as verified.
- **Reuse existing tools.** Proofs come from LemmaScript and Dafny, design
  models from TLC, tests from your project, model access from pi-ai and the
  terminal from pi-tui.
- **Build for a consumer that exists today.** A capability that claims to
  improve results is measured against the simplest alternative first.
  Research needs only a question and a recorded result.

## Not planned

- **A sandbox of Tesota's own.** An existing operating-system sandbox will
  be used when automated runs need one.
- **A verifier of Tesota's own** for a language or a field.
- **Surfaces beyond the terminal,** such as a GUI or an ACP server, until
  there's a real client. A static file that your browser opens, with
  nothing left running, is part of the terminal's work.
- **Model access of its own.** Providers come from pi-ai.
- **A plan mode.** Ask for a plan in your own words or with a skill. To
  keep anything from changing until you say so, use the read only
  [permission mode](docs/guides/permissions.md), which is enforced on every
  tool call.

## Focus areas

### Evidence for each changed path

A run should be judged per changed file: which tests exercised it, run by
the runner of the workspace it belongs to, and what to say when a run
changes nothing. See the open issues
[#669](https://github.com/sequelcore/tesota/issues/669),
[#674](https://github.com/sequelcore/tesota/issues/674),
[#638](https://github.com/sequelcore/tesota/issues/638),
[#627](https://github.com/sequelcore/tesota/issues/627) and
[#536](https://github.com/sequelcore/tesota/issues/536).

### Findings that become checks

A reviewer's finding is a candidate, not evidence. The direction is a
reviewer that proposes checks you approve, rather than verdicts. See
[#397](https://github.com/sequelcore/tesota/issues/397) and
[#429](https://github.com/sequelcore/tesota/issues/429).

### Receipts you can share

A receipt as a page generated from its evidence, and the owners that
`CODEOWNERS` gives each changed path. See
[#661](https://github.com/sequelcore/tesota/issues/661) and
[#533](https://github.com/sequelcore/tesota/issues/533).

### The agent's tools

A task list the agent keeps while it works, reading web pages and images,
and commands that run in the background. See
[#521](https://github.com/sequelcore/tesota/issues/521),
[#522](https://github.com/sequelcore/tesota/issues/522),
[#523](https://github.com/sequelcore/tesota/issues/523) and
[#524](https://github.com/sequelcore/tesota/issues/524).

### Sessions and models

Starting a session in a new worktree, and choosing which model continues
when a plan's limit stops a run or a session is resumed. See
[#579](https://github.com/sequelcore/tesota/issues/579),
[#597](https://github.com/sequelcore/tesota/issues/597) and
[#679](https://github.com/sequelcore/tesota/issues/679).

### Working from a phone

Sending requests and reading receipts from a phone, through a remote host.
See [#467](https://github.com/sequelcore/tesota/issues/467).

### Reliability

Open [bugs](https://github.com/sequelcore/tesota/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
and the performance budgets on Windows.

## Proposing a change

Open an [issue](https://github.com/sequelcore/tesota/issues/new/choose)
first. See [CONTRIBUTING.md](CONTRIBUTING.md).
