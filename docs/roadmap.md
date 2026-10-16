# Roadmap

This page owns current status and priorities. Earlier proposals, evaluations
and the earlier agent remain in Git history.

## Status

On 2026-10-15 the owner decided that Tesota builds its own engine,
`@tesota/core` on Bun, with a terminal shell of parallel sessions, and stops
running inside Pi ([decision record](decisions/2026-10-15-own-engine.md),
[engine study](design/engine-study.md)). Nothing of it is built yet; until
the engine passes its contract, the Pi package below is the working Tesota.

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

It tells a comment-only change from code by parsing each side of a file:
JavaScript and TypeScript with their parser, Python and Go with tree-sitter
grammars, and any other language as code. This was planned for when a
Python project first went through Tesota; measurements showed the
line-by-line reading it replaced also hid changes in Go, so it was
reprioritized and done on 2026-10-14
([#394](https://github.com/sequelcore/tesota/issues/394)).

`prove` turns on once the agent writes a project's first contract. A skill
for writing contracts was measured on 2026-10-15 and does not ship: with or
without one, agents asked for a first contract wrote one that proved and
ruled out the bug in nearly every run, Midspiral's LemmaScript skills helped
a little on proofs that need loop invariants at about twice the tokens, and
the README mentions them with that result
([#387](https://github.com/sequelcore/tesota/issues/387),
[measurements](design/verification.md#measurements)).

The receipt lists the cases the operator's request leaves open, as a
model's notes for the operator to settle, since agents settle them silently
with contracts that prove either way. GPT-6 Sol lists them unless the
operator names another model or turns the list off; on held-out requests it
found every open case with few false alarms. Done on 2026-10-15
([#397](https://github.com/sequelcore/tesota/issues/397),
[open cases](design/verification.md#open-cases)).

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

- **Tesota's engine**
  ([#432](https://github.com/sequelcore/tesota/issues/432),
  [decision record](decisions/2026-10-15-own-engine.md)). `@tesota/core`
  and the `tesota` shell, built in slices with an issue each. The first
  slices are the contract inventory and its tests against a pinned Pi, the
  request ledger that compaction never replaces, and the settlement
  lifecycle with verification as its mandatory step; the
  [engine study](design/engine-study.md) ranks the rest. Parallel sessions,
  one worktree each, come with the shell and replace
  [#373](https://github.com/sequelcore/tesota/issues/373).
- **12. Alpha, part 2**
  ([#372](https://github.com/sequelcore/tesota/issues/372)) waits for the
  engine: the alpha ships on `@tesota/core`, not as a Pi package. Then `dev`
  reaches `main`, where the receipt's in-toto `predicateType` names
  [receipt v1](receipt-v1.md), and it is published to npm.
- **Findings become evidence**
  ([#375](https://github.com/sequelcore/tesota/issues/375)). A model judge
  does not return as a verdict: a model's opinion is a candidate, not
  evidence. The gate as designed, a test the agent derives from the finding
  that fails on the change and passes after its fix, was measured and does
  not ship: it kept most false findings and lost real ones
  ([measurements](design/verification.md#measurements)). A redesign that
  grounds a finding's expected behavior in the request, a contract or a test
  the operator approves is proposed on the issue, and in
  [#397](https://github.com/sequelcore/tesota/issues/397), whose first part,
  the receipt's list of open cases, is done.
- **A workspace of several repositories**
  ([#384](https://github.com/sequelcore/tesota/issues/384)). Opened in a
  folder that holds several Git repositories but is not one, Tesota verifies
  nothing today. It is to take a base per repository, verify each one the
  request changed with its own commands, and settle with one receipt.
- **Remote work: Happier recommended**
  ([#388](https://github.com/sequelcore/tesota/issues/388)). The owner accepts
  Happier for Android session use. Tesota remains a Pi extension; Happier is
  an optional host, not a bundled dependency. The [user guide](remote-work.md)
  covers setup and receipts. The pilot uses local host corrections for
  settlement, receipt delivery and CLI waiting; upstream publication and
  remaining phone-workflow qualification are open. Conversation recovery
  does not recover interrupted execution. The
  [decision](decisions/2026-10-13-remote-session-host.md) records evidence and
  limits. It relies on Pi's RPC, so it is reviewed once the engine exists.
- **Rules in plain words for work that is not code,** after the alpha
  ([decision record](decisions/2026-10-09-plain-language-rules.md)): budgets,
  reports and spreadsheets done with a coding agent. The person states a
  rule, approves its check through concrete cases, and Tesota shows the
  check can fail before trusting it. A pilot on one real task comes before
  any issue.

## Open questions

- **Where Pi's packages still fit.** With its own engine, Tesota no longer
  carries Pi packages ([#385](https://github.com/sequelcore/tesota/issues/385)).
  `pi-ai` stays for model access until it causes a problem it does not
  solve; whether Tesota's engine runs Pi extensions beyond the API Tesota
  uses is decided when a real extension needs it.
