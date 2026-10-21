# Roadmap

Tesota makes a coding agent show evidence that its change does what was
asked: proved where it can, tested where it can't, and plain about what it
couldn't verify. This page states the principles Tesota is built on, what
it won't do, and where the work is going. The plan itself lives in
[GitHub issues](https://github.com/sequelcore/tesota/issues); this is a
statement of direction, not a commitment to dates.

## Principles

- **Results, not actions.** Tesota checks what the change does, not what
  the agent did on the way. Permissions limit actions; they aren't
  verification.
- **Evidence is not judgment, and neither is acceptance.** A proof or a
  passing test is evidence. A model's opinion is labeled as one and never
  counts toward what needs you. Accepting a change is always a person's.
- **Say what wasn't verified.** A passing check never hides what nothing
  checked.
- **Verification can't be skipped.** It's a step of every run, which no
  extension can replace, and a run that wasn't verified never ends as done.
- **Reuse, don't rebuild.** Proofs come from LemmaScript and Dafny, tests
  from your project, models from pi-ai, the terminal from pi-tui.
- **A capability needs a consumer that exists today,** and one that claims
  to improve results is measured against the simplest alternative first.
  Research and experiments don't wait for one: they need a question and a
  recorded result, and a result that justifies building names its consumer.

## Not planned

- **A sandbox of Tesota's own.** An existing operating-system sandbox will
  be used when automated runs need one.
- **A verifier of Tesota's own,** for a language or a field.
- **Surfaces beyond the terminal shell,** such as a GUI or an ACP server,
  until there's a real client.
- **Model access of its own:** providers come from pi-ai.
- **A plan mode.** A plan is something you ask for, in your own words or
  with a skill. What a plan mode stands for, nothing changes until you say
  so, is the **read only** [permission mode](docs/guides/permissions.md),
  enforced on every tool call rather than asked of the model. And a plan
  isn't evidence: the gate checks what the change does, whatever was
  planned.

## Focus areas

### The alpha

Tesota 0.1.0 is used for real before it's published. Then it ships as
prebuilt binaries for each platform, carrying what verification reads from
the checkout today (the grammars and LemmaScript's `lsc`), `dev` reaches
`main`, and the receipt's format URL resolves
([#372](https://github.com/sequelcore/tesota/issues/372)).

### Findings that become evidence

A reviewer's finding is a candidate, not evidence. The direction is to
ground a finding's expected behavior in the request, a contract, or a test
you approve, building on the open cases the receipt already lists
([#375](https://github.com/sequelcore/tesota/issues/375),
[#397](https://github.com/sequelcore/tesota/issues/397)).

### Rules in plain words, for work that isn't code

People use coding agents for budgets, reports and spreadsheets too. The
direction: you state a rule of your field in plain words ("the November
budget must not change"), the agent turns it into a check written before
the work and kept apart from it, you approve the check through concrete
cases rather than its description, and Tesota shows the check can fail
before trusting it. A pilot on one real task comes first.

### Working from a phone

Sending requests and reading receipts from a phone, through Happier or
another remote host, on the engine
([#467](https://github.com/sequelcore/tesota/issues/467)).

### Reliability

Concurrent snapshots of one folder
([#461](https://github.com/sequelcore/tesota/issues/461)), the Windows
first-frame budget's noise
([#462](https://github.com/sequelcore/tesota/issues/462)), and test
isolation on Linux ([#466](https://github.com/sequelcore/tesota/issues/466)).

## Proposing a change

Open an [issue](https://github.com/sequelcore/tesota/issues/new) to discuss
it first. See [CONTRIBUTING.md](CONTRIBUTING.md).
