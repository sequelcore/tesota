# Roadmap

This page owns current status and priorities. Earlier proposals, evaluations
and the earlier agent remain in Git history.

## Status

On 2026-10-08 Tesota's direction changed: it stopped being a full coding
agent and became an open verification layer, shipped as a Pi package and a
`tesota` command that opens Pi with it
([decision record](decisions/2026-10-08-verification-layer.md)). Refactor
slices 1–9 are on `dev`. In a project with LemmaScript contracts, Tesota
gives the agent `prove`, and before a run settles it:

- proves the changed files;
- runs the project's commands and checks changed tests against the
  request's base;
- measures the strength of new contracts by mutation and ClaimCheck;
- sends failures and weak contracts back to the agent.

The run ends with a receipt that `tesota receipt` writes for a pull request.
The [verification design](design/verification.md) describes how each of
these works.

## Next

The refactor lands on `dev` in slices, one pull request each. Every slice
passes `bun run check`, `bun run formal:check` and `git diff --check`.
Slices 1–9 and 11 are done; the
[decision record](decisions/2026-10-08-verification-layer.md#slices) links
each one's issue and pull requests.

- **12. Alpha.** Version 0.1.0 installs from its packed file, through
  `pi install` and the `tesota` command. Publish it to npm after a week on
  a real project. The receipt's in-toto `predicateType` names
  [receipt v1](receipt-v1.md) on `main`, which resolves once `dev`
  reaches `main`.
- **10. Parallel sessions,** after the alpha. Recommend an existing Pi package,
  or raise the gap with Pi.

## Open questions

- Whether a narrow model judge returns after slice 7, with two jobs only:
  whether the agent gamed the checks, and whether the change does what was
  asked. Its verdict would be labelled opinion, never run on proved code and
  never override a proof.
