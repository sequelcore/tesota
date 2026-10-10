# Roadmap

This page owns current status and priorities. Earlier proposals, evaluations
and the earlier agent remain in Git history.

## Status

On 2026-10-08 Tesota's direction changed: it stopped being a full coding
agent and became an open verification layer, shipped as a Pi package and a
`tesota` command that opens Pi with it
([decision record](decisions/2026-10-08-verification-layer.md)). Refactor
slices 1–9 and 11, and the first part of 12, are on `dev`, as version
0.1.0. In a project with LemmaScript contracts, Tesota gives the agent
`prove`, and before a run settles it:

- proves the changed files;
- runs the project's commands and checks changed tests against the
  request's base;
- measures the strength of new contracts by mutation, dropping mutants the
  prover shows equivalent, and by ClaimCheck;
- sends failures and weak contracts back to the agent.

The run ends with a receipt that `tesota receipt` writes for a pull request,
and the footer shows the gate's progress and the receipt's summary. The
`tesota` command opens Pi under the palo fierro, in Tesota's theme until
the operator chooses one. The [verification design](design/verification.md)
describes how each of these works.

## Next

The refactor lands on `dev` in slices, one pull request each. Every slice
passes `bun run check`, `bun run formal:check` and `git diff --check`.
Slices 1–9 and 11 are done; the
[decision record](decisions/2026-10-08-verification-layer.md#slices) links
each one's issue and pull requests.

- **12. Alpha, part 2**
  ([#372](https://github.com/sequelcore/tesota/issues/372)). Version 0.1.0
  installs from its packed file, through `pi install` and the `tesota`
  command. A week on a real project comes first; then `dev` reaches `main`,
  where the receipt's in-toto `predicateType` names
  [receipt v1](receipt-v1.md), and 0.1.0 is published to npm.
- **10. Parallel sessions,** after the alpha
  ([#373](https://github.com/sequelcore/tesota/issues/373)), on Pi's public
  APIs. `pi-parallel-sessions` was tried and rejected: it patches Pi's
  internals, and its sessions would run without Tesota.
- **Upstream reports** for LemmaScript and Pi
  ([#374](https://github.com/sequelcore/tesota/issues/374)).
- **Findings become evidence,** after the alpha
  ([#375](https://github.com/sequelcore/tesota/issues/375)). A model judge
  does not return as a verdict: a model's opinion is a candidate, not
  evidence. Tesota instead becomes the empirical gate a finding passes
  before the receipt states it: the agent turns the finding into a test that
  fails on the change, and Tesota confirms it fails, then that the fix makes
  it pass without weakening anything. It ships only if, on registered cases
  with planted bugs, the gate removes false findings without losing real
  ones.
- **A workspace of several repositories**
  ([#384](https://github.com/sequelcore/tesota/issues/384)). Opened in a
  folder that holds several Git repositories but is not one, Tesota verifies
  nothing today. It is to take a base per repository, verify each one the
  request changed with its own commands, and settle with one receipt.
- **A skill for writing and strengthening contracts**
  ([#387](https://github.com/sequelcore/tesota/issues/387)), shipped in the
  package, so an agent can write the first contract where there is none.
  Measured before a release.
- **Remote work,** after the alpha
  ([#388](https://github.com/sequelcore/tesota/issues/388)): driving the agent
  from a phone while it runs on a computer or a VPS, with the receipt where
  the person is. Pi Durable (Earendil's experimental framework for
  long-running, crash-surviving agents) can't run Pi extensions yet
  ([pi#10386](https://github.com/earendil-works/pi/issues/10386)); community
  hosts built on Pi's own runtime may. Every route must load Tesota in each
  session it starts, and Tesota does not build its own remote host.
- **Rules in plain words for work that is not code,** after the alpha
  ([decision record](decisions/2026-10-09-plain-language-rules.md)): budgets,
  reports and spreadsheets done with a coding agent. The person states a
  rule, approves its check through concrete cases, and Tesota shows the
  check can fail before trusting it. A pilot on one real task comes before
  any issue.

## Open questions

- **Which existing Pi packages Tesota carries or recommends,** such as
  sub-agents or permissions, beside the verification it builds
  ([#385](https://github.com/sequelcore/tesota/issues/385)). Each must keep
  Tesota's extension active in the sessions it starts, as parallel sessions
  must ([#373](https://github.com/sequelcore/tesota/issues/373)), and a user
  can turn it off with `pi config`. Decided after the alpha's week of use
  ([#372](https://github.com/sequelcore/tesota/issues/372)), including
  whether Tesota installs them or only recommends them.
