# Verification

This page describes how Tesota verifies an agent's change, as the code on
`dev` does it. Tesota is a [Pi](https://pi.dev) extension (`src/extension.ts`):
it gives the agent `prove`, holds a completed run open while the change's
evidence is missing or can be improved, and ends the run with a receipt. It
never decides what the agent may do; Pi and the operator own that.

Each rung of the ladder answers a narrower question than the one before, and
the receipt keeps their answers apart:

1. **Proved.** The changed file's LemmaScript contracts hold for every input
   they admit (LemmaScript with Dafny).
2. **Tested.** The project's own commands pass with the change.
3. **Exercised.** A changed or added test fails without the change.
4. **Strong enough.** Small changes to a proved function's body break its
   proof, unless Dafny proves they behave the same.
5. **Judged.** A model compares each new contract with the request. This is
   labelled a model's judgment and never counts as a proof.

Alongside the ladder, the receipt lists what may weaken the evidence and what
nothing verified, down to changed lines.

| Behavior | Owner |
| --- | --- |
| The gate and its order | `src/gate.ts` |
| Evidence and its content hash | `src/evidence.ts` |
| Proofs and `prove` | `src/verification/lemmascript-verifier.ts`, `src/prove-tool.ts` |
| Weakened evidence | `src/verification-changes.ts` |
| Tests and exercise | `src/projects.ts`, `src/test-rung.ts`, `src/test-report.ts` |
| Contract strength | `src/proof-guarantees.ts`, `src/proof-mutation.ts`, `src/pi-claimcheck.ts` |
| Coverage | `src/proof-coverage.ts` |
| The receipt and `tesota receipt` | `src/receipt.ts`, `src/pull-request-receipt.ts` |
| Processes and their limits | `src/process.ts` |
| What the operator sees of the gate | `src/gate.ts` (`GateProgress`), `src/footer.ts`, `src/editor.ts`, `src/messages.ts` |

## Evidence

A verifier run produces an `Evidence` record: which verifier ran
(`lemmascript` or `command`), the claim a pass establishes, what it does not
establish, how it ended, the end of its output, its duration, the files it
checked and a SHA-256 of those files' paths and content. Evidence describes
the files only while their content still has that hash. A proof's evidence
covers the TypeScript file and its `.dfy` as they are after the run. A
command's evidence covers the changed files as they were when the commands
started.

Outcomes are `passed`, `failed`, `vacuous`, `timed_out`, `cancelled` and
`not_started`. A proof passes only when `lsc regen` succeeded, `lsc check`
exited cleanly and Dafny reported at least one verified obligation; a clean
exit with nothing verified is `vacuous`, never proved (`proofOutcome`, proved).

## The request and its base

A request starts with the operator's input, not with input from an
extension. Before the agent can run anything, Tesota records the commit `HEAD`
names as the request's base. A steer or follow-up sent while the agent works
joins the request already running. Everything the gate sent back resets on the
operator's next input.

The changed files are those that differ from the base, excluding deletions,
plus untracked files Git does not ignore; before the first commit, every
tracked file counts. A commit the agent makes during the request hides
nothing, since the comparison is with the base.

## The gate

The gate runs at Pi's `agent_before_settle` when a run completes. A run that
changed nothing and weakened nothing settles without a receipt. Otherwise the
gate climbs the ladder in order, and at each step it may send failures back
to the agent with `continue`, which keeps the run going:

1. Prove each changed TypeScript file with `//@` annotations, and each whose
   `.dfy` or `.dfy.gen` changed.
2. Once no proof goes back, run the project's commands.
3. Once no command goes back, measure each new or changed contract's
   strength, and send back the weak ones.
4. When nothing goes back, settle with the receipt.

Every rung uses the same rule to decide what goes back (`gateVerdict`,
proved). A `failed` or `vacuous` result goes back to the agent, unless its
failure repeats one already sent back for the same file, command or contract
during the request. A repeat is `no_progress`: the correction made no
progress, even when it alternates between failures, and the receipt reports it
instead of sending it again. A result that could not run, ran past its limit
or was stopped is the operator's (`operator`) and never goes back. The run
continues while anything goes back (`keepsWorking`, proved).

What counts as a repeat:

- **Proofs:** the proof's outcome and output.
- **Commands:** the set of failing tests, read from the JUnit XML reports
  the command wrote. A command that writes no report goes back once, since
  its output varies from run to run.
- **Weak contracts:** the list of surviving mutants.

Outside a Git repository the gate cannot tell what changed. A request that
ran any tool other than `read`, `grep`, `find`, `ls` or `prove` ends with a
receipt saying its changes were not verified. Otherwise the run settles with
no receipt.

## Proofs

`proveFile` runs LemmaScript's `lsc` in the project itself: `lsc regen`
merges the changed source into the file's `.dfy`, keeping the proof lines
added by hand, then `lsc check` proves it with the operator's Dafny. Proving
in a copy would leave the project's `.dfy` behind the source. Each process
has a 5-minute limit. When Dafny does not answer, the outcome is
`not_started`. `src/process.ts` starts these processes and stops each one
with every process it started.

`prove` gives the agent the same run on one file while it works. It is
inactive until the session finds a TypeScript file with `//@` annotations
(`hasContracts`, which reads at most 20,000 entries and skips dependency,
build and dot folders). It runs alone, so its evidence describes files no
other tool call left half-written. Its guidance tells the agent to work
until the proof passes, gives LemmaScript's annotation syntax, and forbids
removing or loosening a contract or adding `//@ assume`. After a failed or
vacuous proof, the result says what to try next.

## Weakened evidence

From the diff against the base, fixed rules list the changes that may
weaken the evidence. The agent cannot argue a change off this list; the
operator decides whether each one is legitimate. Matching a removed line
with an added one ignores spacing, so moving a line or reindenting it counts
as unchanged (`weakens`, proved).

- **Contracts:** a removed or changed `//@ requires` or `//@ ensures`.
- **New preconditions:** a `//@ requires` added to a function the base had.
- **Assumptions:** an added `//@ assume`.
- **Dafny proofs:** an added `assume` or `{:axiom}` line in a `.dfy`, or a
  lemma left without a body, which Dafny takes as an axiom.
- **Tests:** a deleted test file, by the common runners' path conventions
  (`tests/`, `__tests__/`, `*.test.ts`, `*_test.go`, `test_*.py`, snapshots
  and the like), or an edit to one that may weaken its tests
  (`testWeakens`, proved): it removes a line that is not blank,
  comment-only or an import it widened (an added line imports from the same
  module, in the same form, every name it had and more), even one that
  moved, so an assertion commented out counts;
  or it adds a line that changes how the existing tests run: a focus or
  skip marker (`.only`, `.skip`, `xit`, `@Disabled`, `#[ignore]`, `t.Skip`,
  `pytest.mark.skip` and the like), a setup or teardown hook (`beforeEach`,
  `@BeforeEach`, `setUp`, an autouse fixture, `TestMain`), or a module mock
  (`vi.mock`, `jest.mock`, `mock.module`). A new test file, or one that only
  gains tests, is not listed. Spies and per-test patches (`vi.spyOn`,
  `@patch`, `@Mock`) are left out, since a test usually restores them; a
  line added inside an existing test, such as an early `return`, is not
  caught either.

When Git's output for the diff passes 16 MiB, the receipt says the change
was not checked for weakening, and coverage is not measured either. The gate
then waits for Git to exit instead of killing it, since on Windows killing
Git's launcher leaves the real Git running in the project. When Git cannot
show the diff, the receipt says so.

## Tests

`suggestChecks` finds the projects in the repository, at the root and up to
three folders below it, and the commands each appears to check itself with:

| Project | Commands |
| --- | --- |
| JavaScript package | its `check` script, or else its `typecheck`, `lint` and `test` scripts, run by the package manager its lockfile names |
| Gradle | `check`, through `./gradlew` when present |
| Maven | `verify`, through `./mvnw` when present |
| Cargo | `cargo test` |
| Go | `go test ./...` |

The gate runs the commands of the deepest project that holds each changed
file (`owner`, proved), from the root through `cd <folder> &&`, in the shell
Pi's `bash` tool uses. Each command has a 15-minute limit. It reads the
failing tests from `.xml` JUnit reports written under the project's folder
while the command ran.

When every command passes and the request has a base, each changed or added
test file is run alone over the base. Snapshots are excluded, since they are
compared against rather than run. This happens in a Git worktree in the
computer's temporary folder, with the checkout's `node_modules` linked in:

- A test that passes there is reported as not exercising the change.
- A test that fails there while the base passes without it exercises the
  change (`checkOrigin`, proved).
- Anything else stays unknown, with the reason.

When the change touches `package.json` or a lockfile, the base runs with the
wrong dependencies, so no run there gives a verdict.

## Contract strength

A contract is the `//@` block directly above a function declaration. Once
the commands pass, each contract the request added or changed in a file that
proved is measured in two ways that run at the same time.

**Mutation** (`mutateContract`) proves up to 8 small changes to the
function's body, each alone in a temporary folder, without the file's
hand-written `.dfy` proof lines. The operators take turns, so the cap keeps
a mix:

- **Result:** return another of the function's returned values.
- **Comparison:** flip a comparison.
- **Constant:** move a number by one.
- **Arithmetic:** swap `+` and `-`.

A mutant whose proof fails is ruled out by the contract. One that times out
or cannot run is inconclusive. One that still proves is a survivor
(`mutantFinding`, proved). This is Lahiri's completeness metric (FMCAD 2024),
with the prover in place of tests; no model decides it.

**Equivalence** (`equivalenceSource`) asks Dafny, the same way, whether a
survivor returns the same result as the code for every input the
`requires` admit. A survivor proved equivalent is only counted
(`equivalentMutant`, proved). A survivor stays one when the equivalence
cannot be built or does not prove:

- the function calls itself;
- a parameter is not a plain name;
- the declaration spans lines;
- the equivalence fails to prove, such as for a function with a loop, which
  becomes a Dafny `method` that a specification cannot call.

A contract with survivors is a weak contract. Its survivors go back to the
agent with a request to strengthen the contract while keeping it provable,
until they repeat.

**ClaimCheck** (`claimCheck`) adapts the round-trip method of
[ClaimCheck](https://github.com/metareflection/claimcheck) through Pi's
model registry in two separate requests:

1. **Restate:** a model restates each contract literally, without seeing the
   request. This is the model `--claimcheck-model <provider>/<id>` names, or
   else the session's.
2. **Compare:** the session's model compares the restatements with what the
   operator asked during the request.

The verdict for each contract is `justified`, `partially_justified`,
`not_justified` or `vacuous`. The receipt labels it a model's judgment, says
when one model made both requests, or says why nothing was judged: no model
selected, an unknown restating model, a failed or missing answer, or more
than 5 minutes for both requests. ClaimCheck never sends anything back.

## Coverage

A file that proved covers only some of its changed lines (`uncoveredLines`).
A line is covered when it lies inside a function with a contract, from the
first annotation to the closing brace, and the change did not narrow that
contract (`proofCovered`, proved).

The weakening list decides narrowing:

- an annotation added inside the function;
- an annotation removed from the base's function of the same name;
- any assumption added to the file's `.dfy`, which narrows every contract in
  the file.

A removed line counts at the line that now follows it. Blank and
comment-only lines are ignored, by the same check the test rule uses; a
`//@` line is a contract, not a comment, so it still counts. The receipt lists the remaining lines as ranges (`ranges`, proved).
A changed file that no proof's evidence covers is listed whole, unless it
is a test file (tests are evidence, reported as exercised, passed or as
something that may weaken the evidence) or every line its change added or
removed is blank or comment-only. Both lists read "not proved" when the
project's commands passed, and "not verified" otherwise.

## The receipt

When nothing goes back, the run settles with a `tesota-receipt` session
entry. Its text is the receipt as the operator reads it, and its `details`
hold the receipt itself. The receipt records:

- the base, when the request started and settled, Pi's version and the
  session's model;
- each proof with its gate verdict and evidence;
- each measured contract;
- ClaimCheck's run;
- each command;
- each exercise finding;
- the weakened evidence;
- the unverified files and uncovered lines;
- the Git blob id of every file changed from the base as the run left it.

[Receipt v1](../receipt-v1.md) specifies every field.

`tesota receipt`, run in the folder where the session ran, takes the last
receipt on the current branch of the most recently changed Pi session that
has one. It reads the sessions of the Pi the launcher found, through Pi's
`SessionManager`, which it imports only for this command, so the launcher
starts without Pi on its module path. It describes the commit `HEAD` names and adds:

- **Who is accountable:** `--owner`, or Git's `user.email`.
- **Stale evidence:** the proofs and commands whose checked files the
  commit no longer holds as they were checked.
- **Files changed after the receipt:** those whose blob in the commit
  differs from the recorded one, plus any file changed from the base with no
  record.

It writes Markdown for a pull request, which ends by saying the receipt is
check evidence and not a reviewer's acceptance. With `--json` it writes an
unsigned in-toto Statement instead. It refuses a receipt from a run outside
Git.

## What the operator sees

The gate alone changes its status (`GateProgress` in `src/gate.ts`), and
Pi's footer reads it (`EvidenceFooter` in `src/footer.ts`):

- **Before a request:** what the project lets Tesota verify, from
  `hasContracts` and `suggestChecks` at session start (`readiness`, proved):
  proofs and tests, proofs only, tests only, or nothing to check with.
- **While a run settles:** the gate's step (proving, testing or measuring
  contracts), then whether it sent failures back, with what the round found
  so far.
- **After the run:** the receipt in brief.

The operator's next request returns the status to ready, as does a run that
changed nothing or a gate that fails midway. The footer's second row holds
the folder, branch and model, and the context window's use sits at the
right of the first. As the terminal narrows, the model goes first, then the
evidence shortens, and the context % goes last (`footerLayout`, proved).

The input (`FilledEditor` in `src/editor.ts`) is Pi's editor with its frame
redrawn as a filled block, so autocomplete, paste, history, keybindings and
scroll markers stay Pi's. The gate's messages and the receipt have their
own renderers (`src/messages.ts`): a styled title in place of Pi's raw
label, wrapping with a hanging indent. The receipt shows a content hash's
first 12 digits, while the session entry keeps all 64.

## Proved rules

The pure decisions above carry LemmaScript `//@` specifications in
`src/verification/`, proved with Dafny by `bun run formal:check`:

| Rule | Decides |
| --- | --- |
| `proof-outcome-rule.ts` | How a proof ended, vacuous included |
| `gate-rule.ts` | What goes back, what is the operator's, and whether the run continues |
| `weakening-rule.ts` | Which annotation changes may weaken the evidence |
| `test-weakening-rule.ts` | Which changes to a test file may weaken its tests |
| `project-rule.ts` | Which folders hold projects and which project owns a path |
| `check-origin-rule.ts` | Whether a test failure comes from the change |
| `mutation-rule.ts` | What a mutant's proof means, and when a survivor is equivalent |
| `proof-cover-rule.ts` | Which changed lines a proof covers |
| `range-rule.ts` | How the receipt groups line numbers |
| `pi-version-rule.ts` | Whether the Pi found meets the minimum |
| `footer-rule.ts` | What Tesota can verify before a request, and what the footer drops as the terminal narrows |

## Measurements

These results are indicative only: small samples on toy cases, with GPT-6
Luna through Pi on a ChatGPT sign-in. `bun run live:eval`
(`evaluation/live.ts`) reruns them.

- **Weak contracts sent back.** On the three strengthen cases, 5 runs each
  (n = 15 per arm):
  - Sending weak contracts back made the final contract rule out the
    registered bug in 15 of 15 runs, against 2 of 15 with the receipt only,
    at about three times the tokens
    ([#351](https://github.com/sequelcore/tesota/pull/351)).
  - With equivalent mutants dropped, it stayed 15 of 15, at 354k tokens
    against 503k ([#353](https://github.com/sequelcore/tesota/pull/353)).
- **A second ClaimCheck model.** With GPT-5.5 restating, 7 of 53 replayed
  verdicts changed, mostly between not and partially justified. Neither setup
  accepted a contract that allows the bug ([#351](https://github.com/sequelcore/tesota/pull/351)).
- **The test rung without contracts.** On the cases without contracts, 21
  runs per arm, 21 of 21 resolved both with and without Tesota. The cases
  were too easy to separate the arms
  ([#351](https://github.com/sequelcore/tesota/pull/351)).

## Credits

Proofs run on [LemmaScript](https://github.com/midspiral/LemmaScript) by
Midspiral (MIT), a runtime dependency, with
[Dafny](https://github.com/dafny-lang/dafny). The round-trip check adapts
the method and prompt wording of
[ClaimCheck](https://github.com/metareflection/claimcheck) by metareflection
(MIT); [NOTICE](../../NOTICE) keeps its license.
