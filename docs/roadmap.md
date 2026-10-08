# Roadmap

This page owns current status and priorities. Earlier proposals, evaluations
and the earlier agent remain in Git history.

## Status

On 2026-10-08 Tesota's direction changed: it stops being a full coding agent
and becomes an open verification layer that makes a coding agent show
evidence that its change does what was asked. It ships as a Pi package and a
`tesota` command that opens Pi with it. The harness was removed in
[#334](https://github.com/sequelcore/tesota/issues/334); the package loads
into Pi and adds no verification yet. A prototype on the
`proto/verification-layer` branch confirmed that Pi 1.1's extension API
carries the design.

## Next

The refactor lands on `dev` in slices, one pull request each. Every slice
passes `bun run check`, `bun run formal:check` and `git diff --check`.

1. **Remove the harness and scaffold the package.** Done in #334.
2. **Verifier interface and LemmaScript.** One adapter contract: what was
   checked, the outcome and the evidence, bound to a content hash. A
   LemmaScript adapter that regenerates before it checks and treats
   "0 verified" as not proved, and `prove` with the measured guidance.
3. **The gate and the receipt.** A gate at `agent_before_settle` that keeps
   the agent working while the evidence fails, and stops when a correction
   makes no progress; a receipt bound to the content.
4. **Weakened evidence.** A removed or changed `requires` or `ensures`, an
   added `assume`, and a deleted or edited test, from the diff against the
   base.
5. **Test rung.** Find and run the project's tests; a changed or added test
   that also passes on the base is reported as not exercising the change.
6. **Contract strength.** Proof-based mutation and ClaimCheck against the
   request.
7. **Receipt for pull requests.** `tesota receipt` writes Markdown and JSON,
   following in-toto's agentic process evidence proposal where it settles.
8. **Evaluation.** The registered proof cases as a live suite that runs Pi
   with the package.
9. **Documentation.** README, a design page, a decision record that reverses
   the harness decisions, and this roadmap.
10. **Parallel sessions.** Recommend an existing Pi package, or raise the gap
    with Pi.
11. **Alpha.** Publish `tesota` to npm after a week on a real project.

Slices 2 to 8 restore the modules they port from Git and adapt them: the
LemmaScript verifier and `prove`, proof mutation and guarantees, ClaimCheck,
weakened evidence from the diff, finding the project's test command, and the
registered proof cases.

## Open questions

- Whether a narrow model judge returns after slice 7, with two jobs only:
  whether the agent gamed the checks, and whether the change does what was
  asked. Its verdict would be labelled opinion, never run on proved code and
  never override a proof.
