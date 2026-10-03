# Proofs

How Tesota uses LemmaScript proofs, from the working agent's turn to the
operator's decision. This page owns that system: what the agent is given,
what a proof is trusted to settle, how a contract is checked against the
request, where each kind of problem goes, and what the operator sees. Each
part says whether it is built, measured or planned; [the
roadmap](../roadmap.md) owns priorities.

## Three artifacts, three gaps

A change to proved code involves three things: the **request**, what the
person asked; the **contract**, the `//@` lines that state what the code
guarantees; and the **code**. Clover frames verified code generation the same
way, as consistency among a description, formal annotations and code, and
accepted up to 87% of correct programs while rejecting every adversarial
incorrect one ([Sun et al., 2024](https://arxiv.org/abs/2310.17807)). Any of
the three can be the wrong one, and each gap has its own owner:

| Gap | Question | Settled by | Who decides |
| --- | --- | --- | --- |
| Code against contract | Does the code meet its contract, for every input it admits? | The prover | Nobody: the proof is final for what it covers |
| Contract against request | Does the contract say what was asked? | Review and ClaimCheck find candidates; mutation measures strength | The agent when the request is clear; the operator when it is not |
| Code outside any contract | Is the rest right? | Checks and review, as everywhere else | As for any finding ([assurance](assurance.md#correction)) |

Three principles follow from the sources:

1. **The prover is the authority on its gap.** "The prover checks the LLM's
   proposals — the LLM is not trusted, only the prover"
   ([LemmaScript design](https://docs.lemmascript.org/design/)). A model never
   re-decides whether proved code meets its contract.
2. **The contract is where the open question moves.** "The central bottleneck
   is validating specifications: since there is no oracle for specification
   correctness other than the user, we need semi-automated metrics"
   ([Lahiri, 2026](https://arxiv.org/abs/2603.17150)). The person's job "shifts
   to reviewing the contract"
   ([How the loop works](https://docs.lemmascript.org/how-the-loop-works/)), so
   Tesota spends its checking on the contract, and the person's attention only
   where the request leaves intent open.
3. **The cheapest check that settles a question runs first**: the prover,
   then fixed rules, then a model, then the operator.

## The loop inside the turn

*Built: #298, #301, #303.* In a repository with TypeScript files carrying
`//@` lines, the working agent gets the `prove` tool and guidance to keep
contracts provable: loops need invariants; a contract changes only when the
request asks for different behavior, and the agent says so; never remove or
loosen one, or add `//@ assume`, to make a proof pass; and LemmaScript's
annotation syntax, from [its specification](https://docs.lemmascript.org/spec/)
([agents](agents.md#proofs-while-it-works)). A failed `prove` ends with a note
that the work is not finished, at the moment the agent reads the failure.
This is LemmaScript's own loop and Midspiral's lemmafit, which runs the
verifier on every save and continues "until the proof goes through"
([lemmafit](https://midspiral.com/blog/introducing-lemmafit-a-verifier-in-the-ai-loop/)).
What the agent proves is feedback; the run after the turn is the evidence.

Measured with `live:agent --set=proofs`, five runs per case:

| Model | Neither | Guidance only | `prove` with guidance |
| --- | --- | --- | --- |
| Sonnet, invariant cases proved | 1/15 | 15/15 | 15/15 |
| GPT-6 Luna, invariant cases proved | 0/15 | 10/15 | 15/15 |
| GPT-6.1 Sol, invariant cases proved | 0/15 | 15/15 | 15/15 |
| Contracts weakened, all models and arms | 0 | 0 | 0 |

Without either, every model fixed the code and left the proof failing. The
guidance is what makes stronger models finish; the tool is what a weaker one
needs, at about 5k tokens more per turn, against 100k to 350k for the
correction round it saves. On the case built to tempt weakening, Sol proved
it every time from the guidance alone; Luna proved 9 of 20 with the tool and
15 of 20 with the note after a failure (two rounds, p ≈ 0.10), and reported
the unproved obligation instead of weakening whenever it stopped.

**Planned: counterexamples in the feedback.** `prove` returns the end of
Dafny's output. EXVERUS repairs Verus proofs from generated and validated
counterexamples, which it reports as more accurate and more token efficient
than verifier messages alone ([2026](https://arxiv.org/abs/2603.25810)).
Where Dafny reports a counterexample for a failed postcondition, `prove`
would lead with it. Adopted only if the invariant and hard-proof cases show
fewer `prove` runs or more proofs for the same model.

## What a proof covers

*Built: #307, #310.* A proof establishes its contract for the function it
annotates, within LemmaScript's subset and its translation to Dafny, with
numbers modeled as mathematical integers under production range assumptions.
It says nothing about callers, unannotated code, behavior outside that number
model, or inputs its `requires` exclude, and an `assume` narrows it further.

- **`proofCovered`** (`src/verification/proof-cover-rule.ts`, proved): a
  changed line is covered only from the declaration to the closing brace of a
  function whose file proved on this tree, and whose contract the change did
  not narrow. Narrowing is any added `assume`, or a `requires` added to a
  contract that existed before; a new contract's own preconditions are part of
  what it states.
- **A proof that verified nothing is not a pass.** A file whose only `//@`
  line sits in a block comment, or above no function, exits cleanly with
  Dafny verifying 0 items; that is reported as not started.
- **LemmaScript translates the whole file**, unannotated functions included,
  so code in a file with contracts must stay within its subset even where
  nothing is proved.

## Checking the contract

**Proof-based mutation** (*built: #310*). For each contract the change added
or edited, and proved, Tesota changes the function body in one place at a
time and proves each change: a returned value swapped for another the
function returns, a comparison flipped, a number moved by one, `+` and `-`
swapped; at most eight per contract, beside the review. A mutant that still
proves is behavior the contract does not rule out. This is Lahiri's
completeness metric ([FMCAD 2024](https://arxiv.org/abs/2406.09757)) and
nl2postcond's discriminative power
([Endres et al., FSE 2024](https://nl2postcond.github.io/)), with the prover in
place of tests. On a clamp, a contract stating the in-range and
above-maximum results rejected 2 of 5 mutants and kept one real gap, a value
below the minimum; a contract stating only that the result is in range
rejected none. A survivor may behave the same as the original, so it is
reported, never called a defect; a timeout or an empty run decides nothing.

**ClaimCheck** (*built*) restates each proved contract without the request,
then compares the restatement with it. Its authors measured 96.3% over 108
comparisons, about one wrong in 27, and call it "a probabilistic sanity check
that requires human review and approval"
([ClaimCheck](https://midspiral.com/blog/claimcheck-narrowing-the-gap-between-proof-and-intent/)).
It is evidence for the routing below, never acceptance.

## Where each problem goes

Each kind of problem has one destination, chosen by which gap it lies in:

| Problem | Found by | Goes to |
| --- | --- | --- |
| A proof fails during the turn | `prove` | The agent, in the same turn (built) |
| A proof fails after the turn | Tesota's LemmaScript run | The agent, in a correction round with the failing obligation, within the round limit; then the operator (built) |
| A contract was weakened, an `assume` added, or a `requires` added to an existing contract | Flags and fixed rules | The operator (flag built; the rules in sessions planned) |
| Code on proved lines does what a clear request rules out | Review | **The agent: fix the code and strengthen the contract** (built) |
| A contract may not say what was asked, and the request does not settle it | Review or ClaimCheck marking intent | The operator (built) |
| A contract leaves behavior unconstrained | Mutation survivors | Shown to the operator in Guarantees (built) |
| Anything in code no proof covers | Checks and review | As for any finding (built) |

**Fix the code and strengthen the contract** (*built*). A defect on a
proved line means the contract allowed it. When the request rules the
behavior out, the agent can repair both. LemmaScript's loop already treats
either side as adjustable, "adjust one of them, re-run, repeat"
([How the loop works](https://docs.lemmascript.org/how-the-loop-works/)), and
in Clover's framing the contract is as likely to be the inconsistent artifact
as the code; the agent now proves as it works. Repair tools that use the
specification as the oracle assume it is right
([Dafny APR, 2025](https://arxiv.org/abs/2507.03659)), which is exactly what a
defect on a proved line shows it is not. So a fixable finding on a proof-covered
line goes back with a fixed addition to its correction (`correctionPrompt`
in `src/correction.ts`): the contract that allowed it, verbatim, and a request
to fix the code and strengthen that contract so its proof rules the behavior
out, keeping it provable and loosening nothing else. The strengthened contract
is then flagged as a formal-specification change, proved by the agent,
mutated, and compared by ClaimCheck, and the operator sees it at the decision.
The finding stays the operator's only when the reviewer marks the intent
itself unclear.

Measured with `live:agent --set=strengthen` on GPT-6 Luna: three corrections
of a bug a proved contract allowed (a clamp below its minimum, a discount at
exactly 100, a maximum that returned the first item), five runs each, the
agent with `prove` as in a session. Each is judged by the prover: the
contract is **strengthened** when the agent's file proves and the base's
buggy body fails under the new contract, and the original **promise is kept**
when the agent's code proves under the original contract.

| | Without the addition | With the addition |
| --- | --- | --- |
| Code fixed (hidden test) | 15/15 | 15/15 |
| Contract strengthened | 0/15 | 14/15 |
| Original promise kept | 13/15 | 14/15 |

The first run of the addition strengthened the clamp and discount every time
but never the maximum: Luna wrote quantifiers LemmaScript rejects, such as
`forall (i: number, …)`, so its proof did not parse. Adding LemmaScript's
syntax to the guidance raised the maximum from 0 to 4 of 5, and the earlier
proof cases, run again with it, proved all 35 times. A text rule had also
flagged one discount turn as weakening when it had replaced
`\result <= price` with the exact result, which implies it; the prover-based
promise check judges that correctly, so the strengthen set uses it.

This replaces an earlier plan that routed every finding on a proof-covered
line to the operator. Its measurement (`live:review --set=proofs`, Luna, three
rounds per arm) found the same recall, 6 of 6 planted defects in both arms and
no false finding on the correct change, but the defect the contract allowed
was a clear coding error, and sending it to the operator asked a person to
decide an obvious fix. Telling reviewers which lines a proof covered also cost
about 1k tokens more on the correct change and saved none at standard depth, so the
reviewer prompt does not change: the routing is a fixed rule on the finding,
which costs nothing.

**Planned: proof in place of the correctness lens.** In a deep review, a
correctness lens re-reads the change for defects. Where every changed line of
a file is proof-covered and the contract was neither weakened nor left with
mutation survivors, the proof already settled correctness against it, so the
lens skips that file; the security lens never does. This is where the token
saving the proof can buy lies, and it is measured on deep-depth `live:review`
cases before adoption: the same recall on files with planted defects outside
the proof, for fewer tokens.

## What the operator sees

*Built: #307, #310.* The result panel's **Guarantees** tab, as lemmafit's
`/guarantees` report maps requirements to proofs: each contract in a changed
annotated file as written, which anyone who reads TypeScript can read;
whether it proved; what it takes as given, marking what the change added;
ClaimCheck's verdict, labeled as a model's comparison; for a contract the
change added or edited, what mutation found; and the changed lines no proof
covers. Dafny's output stays in Checks. *Planned:* ClaimCheck's plain
restatement beside each contract, which its first pass writes but the review
record does not keep yet.

## Adding contracts

*Planned.* The agent proves contracts that exist. Writing new ones where code
has none is a change nobody asked for unless the request or the repository's
instructions ask, and a contract the agent wrote can prove and still say less
than was meant; models "struggle with quantifiers, recursive predicates, and
ghost variables" ([Lahiri, 2026](https://arxiv.org/abs/2603.17150)). So the
agent adds contracts only when one of those asks, and an added contract takes
the same path as a strengthened one: the agent's proof, mutation, ClaimCheck,
the flag and the operator's decision. `live:agent` cases registered for it
score proved, mutants rejected, ClaimCheck's verdict and scope before the
agent is told to add any.

## Order

1. Fix the code and strengthen the contract. Built.
2. Proof in place of the correctness lens, on deep-depth cases.
3. Counterexamples in `prove`'s feedback, on the `live:agent` proof cases.
4. ClaimCheck's restatement in the Guarantees tab.
5. Adding contracts, on its own `live:agent` cases.

## Sources

- LemmaScript: [design](https://docs.lemmascript.org/design/),
  [how the loop works](https://docs.lemmascript.org/how-the-loop-works/),
  [guidance for agents](https://docs.lemmascript.org/agents/)
- Midspiral: [lemmafit](https://midspiral.com/blog/introducing-lemmafit-a-verifier-in-the-ai-loop/),
  [ClaimCheck](https://midspiral.com/blog/claimcheck-narrowing-the-gap-between-proof-and-intent/),
  [the intent envelope](https://midspiral.com/blog/intent-envelope-proofs-for-completeness-not-just-soundness/)
- Lahiri, [Intent Formalization (2026)](https://arxiv.org/abs/2603.17150) and
  [user-intent formalization for verification-aware languages (FMCAD 2024)](https://arxiv.org/abs/2406.09757)
- Endres et al., [nl2postcond (FSE 2024)](https://nl2postcond.github.io/)
- Sun et al., [Clover (2024)](https://arxiv.org/abs/2310.17807)
- [Specification-guided repair of arithmetic errors in Dafny programs (2025)](https://arxiv.org/abs/2507.03659),
  which repairs code and assumes the specification correct
- [EXVERUS (2026)](https://arxiv.org/abs/2603.25810)
