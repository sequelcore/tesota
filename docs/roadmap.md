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
