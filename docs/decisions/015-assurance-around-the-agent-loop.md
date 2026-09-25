# 015: Verify and review each result before the operator decides

Status: adopted 2026-09-25. Implements the second half of
[decision 013](013-general-agent-loop-first.md) ("then put Tesota's
verification around its result") under the principles of
[decision 011](011-evidence-gated-capabilities.md) and
[decision 012](012-general-purpose-harness.md).

## Context

The general loop works: an agent changes an independent workspace, Tesota runs
the operator's checks on that exact content, and the operator applies or
rejects it. What makes Tesota different is still missing. A passing check
shows the code meets its tests, not that the tests say what the operator
asked; the agent can edit a test until it passes; nothing independent reads
the result; and a failure goes to the operator rather than back to the agent.

Two gaps separate an intent from a result. Verification closes the gap
between a stated specification and the code: tests, type checks, linters and
proofs establish bounded claims about exact content. Review closes the gap
between the intent and the specification: whether the result is what was
asked, whether the evidence covers it, and whether a specification was
weakened. ClaimCheck is an example of the second kind for proofs: it
restates a proved lemma without seeing the requirement and compares the two.

Current practice agrees on the roles. The code review features of Codex,
Claude Code and GitHub Copilot run as a separate pass that reports findings;
continuous integration gates, and people approve the merge. Anthropic's
"evaluator-optimizer" workflow has one model produce and another evaluate in
a loop the application controls. Gentle AI's review freezes the exact change
before reading it, chooses depth by risk, and is informational.

## Decision

Tesota's own code orchestrates four roles. Each answers one question, and
none can do another's job.

| Role | Question | Performed by |
| --- | --- | --- |
| Authority | May this action happen? | The execution environment and approvals ([decision 014](014-execution-and-autonomy.md)) |
| Verification | Does this exact candidate meet a stated claim? | Verifiers that Tesota runs |
| Review | Is this the result that was asked for, and does the evidence cover it? | Reviewers that Tesota launches |
| Acceptance | Is it adopted? | The operator |

### 1. The candidate and its request are fixed

A **candidate** is the workspace's pending changes, identified by their Git
tree. The **request record** holds, verbatim and in order, the operator's
requests since the workspace base last moved; applying or rejecting starts a
new one. Tesota keeps it outside the workspace, so the agent cannot edit it.
Every verifier and reviewer result names the tree it describes; a changed
tree needs new results.

### 2. Changes to what gets checked are flagged

Tesota classifies the candidate's paths with fixed rules and flags changes to
tests, check or lint configuration, CI workflows, formal specifications and
package scripts. Flags go to the reviewers and the operator. A flagged change
may be a legitimate correction; deciding that is the operator's call, never
the agent's.

### 3. Verifiers establish claims

A verifier runs on the frozen candidate and reports its outcome, the claim
the outcome establishes, its limits, the environment and guarantees it ran
under, and the end of its output. Approved check commands are verifiers whose
claim is "this command exits with code 0 on this tree". Later verifiers add
structured claims: Tesota's Oxlint profile on changed JavaScript and
TypeScript files, and LemmaScript with Dafny for changed files that carry
`//@` annotations, reporting which properties were proved. A missing,
unavailable, timed-out or unconfirmed verifier is never reported as passed.

The working agent may run the same tools while it works. Those runs are
feedback for the agent, not evidence; only Tesota's run on the frozen tree
counts.

### 4. Reviewers report findings

Tesota launches each reviewer after verification. A reviewer receives the
request record, the candidate diff, the verifier results and the flags, and
returns findings: a severity, an optional location, a statement, and a
disposition of `fixable` (a defect against the request) or `operator` (an
ambiguity, a trade-off, a flagged change, scope growth or a security-sensitive
choice). A reviewer that does not finish reports an incomplete review, which
is never shown as clean.

Tesota's first reviewer is a separate Pi session with fresh context and
read-only file tools on the candidate, and no shell. It does not see the
working agent's reasoning. Tesota checks that the candidate's tree is
unchanged afterwards. It uses the same model route as the worker, because
that is the only route; its independence is limited to context until a second
route exists. ClaimCheck's method and Gentle AI's review join later as further
reviewers behind the same contract.

### 5. A bounded correction loop

When verifiers fail or reviewers report `fixable` findings, Tesota sends the
working agent the request record unchanged together with those results, then
verifies and reviews the new candidate. At most two correction rounds run.
The loop stops early when a round leaves the tree unchanged; findings are
worded anew by each review, so their text cannot show that nothing improved.
`operator` findings, incomplete reviews and checks that could not run never go
back to the agent. The operator sees each round, and can stop it.

### 6. The operator decides on the whole record

The review shows the candidate, each verifier's claim and outcome, each
reviewer's findings, the flags and the rounds. Application writes exactly the
reviewed tree, as before. Tesota appends each candidate's record, and the
operator's decision, to the workspace's assurance journal.

## Delivery

Each slice is usable on its own and is followed by use on Tesota's own
changes before the next.

1. **Request record and flagged changes.**
2. **Tesota's reviewer**, qualified on seeded defects (a boundary mistake, a
   weakened test, an unaddressed requirement) with what it misses recorded.
3. **The correction loop.**
4. **The verifier contract**, with approved checks moved onto it, then Oxlint
   and LemmaScript with Dafny as adapters.
5. **Further reviewers:** ClaimCheck's method through Tesota's model route,
   and Gentle AI's review through its published contract.
6. **Workflow profiles** that choose verifiers, reviewers and loop limits per
   repository, once two real alternatives exist.

## Consequences

- A request costs more model calls and time: one review per candidate and up
  to two correction rounds.
- The operator reads findings as well as the diff; findings are advice, and a
  clean review does not replace reading the change.
- Reviewer independence is partial while one model route exists.
- Formal verification applies only where a repository annotates functions.

## Rejected alternatives

- **An orchestrating agent that decides when to verify and review.** It can
  skip steps; the steps that produce evidence must always run.
- **Letting the working agent invoke its reviewer.** It would choose when it
  is reviewed and what the reviewer sees.
- **A reviewer with a shell or edit tools.** It could change the candidate it
  reviews; read-only file tools are enough for the first reviewer.
- **Treating the agent's own verifier runs as evidence.** The agent chooses
  what to run and on which content.
- **A workflow framework first.** Slots are extracted once two real workflows
  show what varies; building them first is how Kiln grew without stabilizing.
- **Mandatory up-front specifications.** Gentle AI removed its specification
  phases as too costly for current models; the request record and review cover
  the same risk with less ceremony.
