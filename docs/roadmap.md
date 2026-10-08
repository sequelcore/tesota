# Roadmap

This page owns current status and priorities. Earlier proposals, evaluations
and the earlier agent remain in Git history.

## Status

On 2026-10-08 Tesota's direction changed: it stops being a full coding agent
and becomes an open verification layer that makes a coding agent show
evidence that its change does what was asked. It ships as a Pi package and a
`tesota` command that opens Pi with it. The harness was removed in
[#334](https://github.com/sequelcore/tesota/issues/334). In a project with
LemmaScript contracts the package gives the agent `prove`
([#337](https://github.com/sequelcore/tesota/issues/337)), holds the run
open while a changed file's contracts do not prove, and ends it with a
receipt ([#339](https://github.com/sequelcore/tesota/issues/339)) that also
lists the changes that may weaken the evidence, measured from the commit the
request started at ([#341](https://github.com/sequelcore/tesota/issues/341)).
Before it settles it runs the project's tests and reports a changed test
that passes without the change
([#342](https://github.com/sequelcore/tesota/issues/342)). For each contract
the request added or changed that proved, the receipt says whether small
changes to its code still prove, which makes it too weak to trust, and how
the session's model judged it against the request, labelled as a model's
judgment ([#345](https://github.com/sequelcore/tesota/issues/345)). It lists
the changed lines of a proved file that no contract's proof covers, and
`tesota receipt` writes the last receipt for a pull request
([#347](https://github.com/sequelcore/tesota/issues/347)). A prototype on the
`proto/verification-layer` branch confirmed that Pi 1.1's extension API
carries the design.

## Next

The refactor lands on `dev` in slices, one pull request each. Every slice
passes `bun run check`, `bun run formal:check` and `git diff --check`.

1. **Remove the harness and scaffold the package.** Done in #334, keeping
   the test-origin and proof-coverage rules, the JUnit report reader and the
   tree's renderer.
2. **Verifier interface and LemmaScript.** Done in #337: evidence bound to
   a content hash, a LemmaScript adapter that regenerates before it checks
   and treats "0 verified" as not proved, and `prove` with the measured
   guidance.
3. **The gate and the receipt.** Done in #339: a gate at
   `agent_before_settle` sends a failed or vacuous proof of a changed file
   back to the agent and stops when a correction repeats any failure
   already sent back; a proof that could not run goes to the operator. Receipt v0 lists each
   proof with its content hash and the changed files nothing verified.
4. **Weakened evidence.** Done in #341: the gate measures changes from the
   commit the request started at, so an agent's commit hides nothing, and
   the receipt lists a removed or changed `requires` or `ensures`, a
   `requires` added to an existing function, an added `assume` in source or
   a `.dfy` (where an `{:axiom}` or a lemma without a body counts as one),
   and a deleted or edited test.
5. **Test rung.** Done in #342: once no proof goes back, the gate runs the
   commands of the projects that own the changed files, sends failing tests
   back until their set repeats, and runs each changed or added test file
   over the commit the request started from, in a Git worktree; one that
   passes there is reported as not exercising the change.
6. **Contract strength.** Done in #345: once the tests pass, up to 8 mutants
   of each contract the request added or changed in a proved file are proved
   alone, and the receipt calls a contract with a surviving mutant a weak
   contract; ClaimCheck has a model restate each contract without the
   request, the second model `--claimcheck-model` names or else the
   session's, then has the session's model compare the restatement with
   it, and the receipt labels that verdict a model's judgment and says when
   one model made both requests. Neither sends anything back to the agent.
   Mutation flags the registered clamp and discount weak contracts; the
   maximum case's one mutant is ruled out by its contract, and ClaimCheck
   on GPT-6 Luna judged that contract not to express the request in 3 of 3
   live runs.
7. **Receipt for pull requests.** Done in #347: `tesota receipt` writes the
   last receipt in the folder's Pi sessions as Markdown, or with `--json` as
   an unsigned in-toto Statement about the commit `HEAD` names, with the
   predicate fields of in-toto's agentic process evidence proposal
   (in-toto/attestation#600) and the receipt under its `custom`. It names
   the proofs and commands whose checked content the commit no longer holds.
   The receipt lists a proved file's changed lines outside every contract
   that proved, or in one the change narrowed, as not covered, through
   `proofCovered`.
8. **Evaluation.** The registered proof cases as a live suite that runs Pi
   with the package. It also measures whether sending a weak contract back
   to the agent helps, and whether a second ClaimCheck model changes its
   verdicts.
9. **Documentation.** README, a design page, a decision record that reverses
   the harness decisions, and this roadmap.
10. **Parallel sessions.** Recommend an existing Pi package, or raise the gap
    with Pi.
11. **Identity.** Tesota's visual identity stays: the animated palo fierro
    tree as Pi's header through `ctx.ui.setHeader`, and Tesota's light and
    dark palettes shipped as a Pi theme. The tree's renderer,
    `src/welcome-mark.ts`, is already here.
12. **Alpha.** Publish `tesota` to npm after a week on a real project.

The slices that port earlier work restore it from the provenance commit
`d0c03f66`, `dev` before the harness was removed, and adapt it there; Git
keeps the tests that went with it.

| Slice | Restores from `d0c03f66` |
| --- | --- |
| 2 | `src/verification/lemmascript-verifier.ts`, `src/integrations/prove-tool.ts` |
| 4 | `src/diff-lines.ts`, `src/verification-changes.ts` |
| 5 | `suggestChecks` from `src/workspace-checks.ts` |
| 6 | `src/proof-mutation.ts`, `src/proof-guarantees.ts`, `src/integrations/pi-claimcheck.ts`, with ClaimCheck's NOTICE entry |
| 8 | The registered proof cases in `src/agent-evaluation.ts` |
| 11 | `src/tesota-shell-theme.ts` and `src/verification/shell-theme-rule.ts` with its proof and the themes' NOTICE entry; the header from `WelcomeBanner` in `src/tesota-shell-welcome.ts` |

## Open questions

- Whether a narrow model judge returns after slice 7, with two jobs only:
  whether the agent gamed the checks, and whether the change does what was
  asked. Its verdict would be labelled opinion, never run on proved code and
  never override a proof.
