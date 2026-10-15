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
| The cases a request leaves open | `src/open-cases.ts` |
| The receipt and `tesota receipt` | `src/receipt.ts`, `src/pull-request-receipt.ts` |
| Processes and their limits | `src/process.ts` |
| What the operator sees of the gate | `src/gate.ts` (`GateProgress`), `src/receipt.ts` (`receiptFindings`), `src/footer.ts`, `src/editor.ts`, `src/messages.ts`, `src/prove-tool.ts` (its renderers) |

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
   `.dfy` or `.dfy.gen` changed. A proof maps back to its source as
   LemmaScript maps it (`proofSources`): beside it, or mirrored under the
   `proof-dir` any `lemmascript.json` of the project sets, which may lead
   out of its own folder, kept only when `lsc config` places that source's
   proof there ([#403](https://github.com/sequelcore/tesota/issues/403)).
2. Once no proof goes back, run the project's commands.
3. Once no command goes back, measure each new or changed contract's
   strength, and send back the weak ones.
4. When nothing goes back, settle with the receipt.

What goes back is a `tesota-gate` session entry. Its text is what the agent
reads; its `details` record what went back, for the operator's view: the
proofs with their evidence, the commands that failed, or the weak contracts.

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

Outside a Git repository the gate measures the request against its own
snapshot of the folder (`takeSnapshot` in `src/snapshot.ts`, #384), taken
when the request starts: Git, run with a Git directory under Pi's agent
directory (`state/tesota/snapshots`) and the folder as its work tree,
commits the folder as it is, and the folder gains nothing. Every step above
then runs as in a repository, so a change any tool made, a shell command's
included, is found by its content. Secrets (`.env`, `.env.*`), Git's and
Jujutsu's folders, dependencies, build output and what the folder's
`.gitignore` names are left out. As pi-workspace-history bounds its history,
a file over 10 MB is left out and listed as not verified, and a folder with
more than 20,000 files or 3,000 folders, or that takes more than 5 s to
read, is not snapshotted. The snapshots of the ten most recently used
folders are kept, and any used in the last day. The receipt marks the base
as a snapshot, which no one else can fetch, and `tesota receipt` writes no
pull request receipt from it.

A home folder or a drive's root is never snapshotted. There, or past a
limit, a request that ran any tool other than `read`, `grep`, `find`, `ls`
or `prove` ends with a receipt saying why its changes were not verified;
otherwise the run settles with no receipt.

A folder that is in no repository but holds Git repositories directly
(`workspaceUnits` in `src/workspace.ts`, #384) is verified repository by
repository. Each repository's base is its own `HEAD` when the request
started, and the gate runs the steps above in each repository the request
changed, from its own folder with its own commands; one it did not change
runs nothing. Each round gathers what goes back across the repositories,
named from the folder Pi runs in (`api/src/rule.ts`, `cd api && bun test`),
and a repeated failure stops only itself. The folders in no repository,
and the folder's own files without the folders below, are measured against
Tesota's snapshot of each, as outside Git. The run settles with one receipt
whose `units` hold each changed unit's evidence; a folder that could not be
snapshotted is listed as not verified, with why, once a tool may have
changed files.

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
(`hasContracts`, which reads the files `projectFiles` walks to: at most
20,000 entries, skipping dependency, build and dot folders), or until the
agent writes or edits one (`annotated`), so an agent writing the first
contract in a project can prove it before the gate does
([#387](https://github.com/sequelcore/tesota/issues/387)). It runs alone, so its evidence describes files no
other tool call left half-written. Its guidance tells the agent to work
until the proof passes, gives LemmaScript's annotation syntax, and forbids
removing or loosening a contract or adding `//@ assume`. After a failed or
vacuous proof, the result says what to try next. A pass says every
contract holds only when the files the proof checked take nothing on trust
and leave nothing out (`provedOnTrust`): each `//@ assume`, `//@ extern`
and `//@ skip` of the source, each function with a contract that a
`//@ verify` on others leaves out, and each `assume`, `{:axiom}` and lemma
without a body written into the `.dfy` by hand. Otherwise it reads
`Proved, but not outright`, names each one in the receipt's words, and asks
the agent to say so in its summary
([#402](https://github.com/sequelcore/tesota/issues/402)). LemmaScript
0.6.4 skips a specification line without a word unless it reads
`//@ <keyword> <expression>`, with one space after `//@` and one after the
keyword: `//@   ensures x`, `//@ensures x` and an empty `//@ ensures` prove
nothing. Such a line is no part of any contract
(`unreadSpecification`), and `prove` names it, says the file is proved but
not all of it, and asks the agent to rewrite it. A result whose proof did
not pass, or passed with a skipped line, is an error result, so Pi draws it
on its error background; its `details` hold the file, the evidence and what
a pass took on trust, for the operator's view of it.

## Weakened evidence

From the diff against the base, fixed rules list the changes that may
weaken the evidence. The agent cannot argue a change off this list; the
operator decides whether each one is legitimate. Matching a removed line
with an added one ignores spacing, so moving a line or reindenting it counts
as unchanged (`weakens`, proved).

- **Contracts:** a removed or changed `//@ requires` or `//@ ensures`.
- **New preconditions:** a `//@ requires` added to a function the base had.
  The function an annotation belongs to is read with the TypeScript parser,
  as LemmaScript's extractor reads it: the declaration its comment leads,
  arrow functions included, or the function holding the statement it leads.
- **Assumptions:** an added `//@ assume`, or an added `//@ extern`, which
  trusts a function's contract without proving its code; LemmaScript emits
  it as an `{:axiom}` function, whose postcondition Dafny assumes "to be
  true without proof".
- **Left out of the proof:** an added `//@ skip` on something the base had,
  which LemmaScript leaves out of the program it generates, so nothing
  proves it: a top-level function, class or variable, a method, or a
  statement inside one of them, named by the one that holds it. Every skip
  reads the same, so a skip only moved when it leaves out the same thing on
  both sides ([#404](https://github.com/sequelcore/tesota/issues/404)).
  Likewise a function the base proved that a `//@ verify` leaves out: once
  any function in a file carries one, LemmaScript extracts only those, any
  it trusts with `//@ extern`, and none of the rest, without a word
  (`extracted`, proved). Each such function is listed, under the
  `//@ verify` that leaves it out.
- **Dafny proofs:** an added `assume` or `{:axiom}` line in a `.dfy`, or a
  lemma left without a body, which Dafny takes as an axiom, when it was
  written by hand. A line the proof's last generated program (its
  `.dfy.gen`) holds is LemmaScript's: it comes from an annotation in the
  source, which counts there, or from LemmaScript's own model of JavaScript,
  such as `split` or `sort`, which is part of the verifier, as Dafny is.
  `lsc regen` rewrites that program from the source and drops from the proof
  a line it no longer generates, so a line written into both files does not
  survive the proof.
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
- **Package check scripts:** a script selected at the request's base whose
  command changes or is no longer selected (`checkScriptWeakens`, proved).
  Discovery selects `check` alone when present; otherwise it selects
  `typecheck`, `lint` and `test` when present (`checkScript`, proved).
  Removing the script or its manifest counts, as does adding a `check` that
  displaces previously selected scripts. JSON formatting, dependencies and
  unselected scripts do not count. The warning names the manifest and script;
  it does not decide whether the new command checks less. Scripts invoked
  indirectly by those commands and test-runner configuration are not traced.

A proof whose source or `.dfy` gained an assumption holds only if what the
change trusts is right (`addedAssumptions`), so the receipt never calls it
proved outright ([#399](https://github.com/sequelcore/tesota/issues/399)).
It says so in plain words, naming what is trusted, and keeps the line as
written in the details: `Proved, trusting 3 unproved parts` and `trusts
lowerBound without proving it` in the conversation, `proved src/rule.ts,
trusting 3 unproved parts the change added` in its text, and `1 proved on
trust` in the footer. Plain words follow the GOV.UK rule to say what a
specialist term means where it is needed; "on trust, without proof" is
what Dafny's `{:axiom}` means.

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
- When the base fails without it too, the JUnit reports both runs wrote
  decide: the test exercises the change when tests fail with it that pass,
  or are missing, without it (`introducedTests`, proved rules). This follows
  SWE-bench's grading, where a test that fails, errors or does not exist
  before a fix and passes after it is fail-to-pass, so a new test for a new
  module counts.
- Anything else stays unknown, with the reason; without reports, a base that
  fails anyway can't tell which tests failed.

When the change touches `package.json` or a lockfile, the base runs with the
wrong dependencies, so no run there gives a verdict.

## Contract strength

A contract is a top-level function's `//@` lines where LemmaScript reads
them (`contracts`, with LemmaScript's own parser): above the declaration,
across comments and blank lines, and the function annotations before the
first statement of its body (LemmaScript's specification, §2.1). An arrow
function with a block body has them read only inside the body. Once
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
than 5 minutes for both requests. ClaimCheck never sends anything back, and
never counts toward what needs the operator: a model's opinion is a
candidate, not evidence
([#375](https://github.com/sequelcore/tesota/issues/375)).

## Open cases

A proof settles code against its contract, not the contract against what
the operator meant, and agents settle a request's open cases silently: on
requests that leave one open, runs settled it differently, each with a
contract that proves, and rarely said so
([#387](https://github.com/sequelcore/tesota/issues/387)). So when the run
settles, a model reads the operator's messages for the request, not the
change, and lists the inputs for which someone who made the request could
expect more than one result, with those results (`openCases`,
[#397](https://github.com/sequelcore/tesota/issues/397)). The receipt
shows each as a model's note for the operator to settle. It never counts
toward what needs the operator, and nothing goes back to the agent.

The model is `--open-cases-model <provider>/<id>`, or GPT-6 Sol, the one
that met every threshold in the measurements below; `--open-cases-model off`
leaves the list out. The receipt says why nothing was listed when the model
is not in Pi's registry, or its request fails, is stopped, gives no answer
or takes more than 2 minutes; the card shows that only when expanded, so a
session without the model keeps its short card. The list runs alongside
the receipt's last steps, about $0.002 a request with Sol.

## Coverage

A file that proved covers only some of its changed lines (`uncoveredLines`).
A line is covered when it lies inside a function with a contract, from the
first annotation to the closing brace, and the change did not narrow that
contract (`proofCovered`, proved). A function LemmaScript skips with
`//@ skip`, or leaves out because the file selects others with
`//@ verify`, has no contract (`contracts`), so none of its lines is
covered, and mutation and ClaimCheck leave it out; nor does a function
whose every specification line LemmaScript skips (`unreadSpecification`).

The weakening list decides narrowing:

- an annotation added inside the function;
- an annotation removed from the base's function of the same name;
- any assumption added to the file's `.dfy`, wherever LemmaScript keeps it
  (the proof's evidence names it), which narrows every contract in the file.

A removed line counts at the line that now follows it. Blank and
comment-only lines are ignored, by the same check the test rule uses
(`commentLines`), which reads each side of a change from the parsed file,
since a line alone shows neither a block comment nor a string around it.
JavaScript and TypeScript are read by their parser, where a `//@` line is a
contract, not a comment, so it still counts. Other languages are read by a
tree-sitter grammar Tesota ships (`grammarCommentLines`), today Python and
Go: a line is comment-only when it has a non-blank character and each lies
inside a comment (`commentOnly`, proved), so a `#` line in a Python
triple-quoted string or a Go `*p = 2` is code. A file whose parse has
errors, and a file in a language no grammar reads, has no comment-only
line, so its comment changes count as code: more files listed, none
missed. Each grammar is copied from its package at the version
`package.json` pins, which a test checks; a language is added when a
project Tesota verifies needs it. The receipt lists the remaining lines as ranges (`ranges`, proved).
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
- the cases the request leaves open, as a model listed them;
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
Git. In a repository of a folder of repositories it writes that repository's
part of the folder's last receipt, and in the folder itself it asks to be
run in a repository.

## What the operator sees

The gate alone changes its status (`GateProgress` in `src/gate.ts`), and
Pi's footer reads it (`EvidenceFooter` in `src/footer.ts`):

- **Before a request:** what the project lets Tesota verify, from
  `hasContracts` and `suggestChecks` at session start (`readiness`, proved):
  proofs and tests, proofs only, tests only, or nothing to check with.
- **While a run settles:** the gate's step (proving, testing or measuring
  contracts), then whether it sent failures back, with what the round found
  so far.
- **After the run:** the receipt in brief. When the request changed only
  comments or blank lines and nothing else is listed, the receipt says
  `no code       nothing to verify: the changes are comments or blank lines
  only`, and the footer `✓ receipt · nothing to verify, comments only`.
  The row leads with `!` when anything in the receipt needs the operator,
  by the same count as the receipt in the conversation (`decisions`,
  proved), and with `✓` otherwise.

The operator's next request returns the status to ready, as does a run that
changed nothing or a gate that fails midway. A resumed session that settled
with a receipt, with no request after it, shows that receipt again. The footer's second row holds
the folder, branch and model, and the context window's use sits at the
right of the first. As the terminal narrows, the model goes first, then the
evidence shortens, and the context % goes last (`footerLayout`, proved).

The input (`FilledEditor` in `src/editor.ts`) is Pi's editor with its frame
redrawn as a filled block, so autocomplete, paste, history, keybindings and
scroll markers stay Pi's.

In the conversation, the receipt, what the gate sends back and `prove` are
drawn from their `details`, with the footer's glyphs (`✓ ✗ ! ○ ↺`, and `◇`
for a model's opinion). Pi applies Ctrl+O to every tool and message at
once, and starts collapsed, so the collapsed view carries the verdict.

- **The receipt** (`src/messages.ts`) is a card whose title row gives the
  verdict: `✓ Nothing needs you`, or `! 4 things need you`. Only findings the
  checks established count (`receiptFindings`, `decisions`); a model's
  opinion that a contract falls short of the request is a note beside the
  verdict, `· ◇ 1 model note`. Under the title, in order: NEEDS YOU, then
  the model's opinion, then what is not proved, and one row of what holds
  (`holdsWords`). That row never reads stronger than the sections above it:
  a label whose check also has a finding that needs the operator or is a
  gap says how many of that check's findings hold, as in `Contract strong
  (1 of 4)` (`partlyHolds`, proved).
  Within each section, proofs and tests come first, then weakening, contract
  strength, test exercise and coverage. A receipt with nothing to decide,
  no gap and no note is its title and that one row. Expanded, each finding
  shows its details (the changes that still prove, the annotation that
  changed, the model's explanation and who judged, the files with the
  hash's first 12 digits and the time) and what holds is listed. The session
  entry keeps the whole hash.
- **What the gate sends back** is a card titled with what failed, such as
  `↺ Sent back to the agent: the tests fail`, with one row for each
  failure. Expanded, it adds the text the agent read, as it read it.
- **`prove`** is Pi's tool card: the file and how long the proof took, then
  `✓ Proved` or `✗ Not proved` with Dafny's error and the contract line it
  points at. Expanded, it adds Dafny's output without the lines that only
  report `lsc`'s own steps.

A message without `details` is left to Pi.

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
| `verdict-rule.ts` | How many of a receipt's findings need the operator, never a model's opinion, and when a summary must say how many of a check's findings hold |

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
- **The note after a proof that verified nothing.** On the placement case, a
  contract above an arrow function with a block body, 5 runs each with GPT-6
  Luna and GPT-6 Sol: every run's first `prove` returned the note. Sol moved
  the contract into the body then; Luna finished its turn with it still above
  and moved it when the gate sent the note back. 10 of 10 proved and
  resolved, at 133k and 107k tokens in all. The 6
  runs scored as weakened rewrote the `ensures` into a stronger one, which
  `contractWeakened`'s verbatim rule does not tell apart. There is no arm
  without the note, so this shows the note is followed, not that it is needed
  ([#393](https://github.com/sequelcore/tesota/pull/393)).
- **Skills for the first contract** ([#387](https://github.com/sequelcore/tesota/issues/387)).
  Each request asked for the first contract in code without one, and each
  arm loaded Tesota's extension alone, plus Midspiral's LemmaScript skills
  at `5bf85afd`, plus those and a draft Tesota skill. Every run that loaded
  a skill read Midspiral's `lemmascript`; the draft was read in 13 of 15
  and 5 of 20 runs.
  - On the strengthen cases without contracts (`first-contract`, 3 cases,
    n = 15 per arm), every arm proved, passed the hidden test and ruled out
    the registered bug in 15 of 15, at a median of 35k, 102k and 108k
    tokens: a ceiling.
  - On the cases whose fixes need loop invariants (`first-proof`, 4 cases,
    n = 20 per arm), all three held in 17 of 20 runs without skills and 20
    of 20 with either, at a median of 71k, 125k and 136k tokens. Two
    misses wrote `**` or `pow` into a power contract, which LemmaScript
    cannot prove; one wrote `//@   ensures` with extra spaces, which
    LemmaScript 0.6.4 ignores without a word, so its proof checked no
    postcondition.
  - On requests that leave one case open (`open-case`, 3 cases, n = 15 per
    arm, with GPT-6 Luna and GPT-6 Sol): a bill split among people, which
    leaves remainders and zero people open; 10% off whole cents, which leaves
    rounding open; and a capped late fee, which leaves negative days open.
    Nearly every run proved, passed the hidden test and ruled out the
    registered bug, but the runs settled the open case differently, each with
    a contract that proves: the split kept fractional cents in 11 of 30 runs,
    rounded down in 15 and required an even split in 4; the late fee charged
    0 for negative days in 16 and required `daysLate >= 0` in 10. Labelled
    from each run's final message with the arm hidden, few said the request
    left the case open, assumed it, or asked: Luna 0, 0 and 2 of 15, and Sol
    1, 0 and 3 of 15, without skills, with Midspiral's and with the draft
    skill as well, which tells the agent to ask. Most runs described their
    choice without marking it as one.

  The draft skill added nothing measurable over Midspiral's and was not
  shipped. With no skill, `prove` was called a median of 3 and 4 times per
  run, since it now turns on once the agent writes a contract. A proof
  settles code against its contract, not the contract against what the
  operator meant; that is
  [#397](https://github.com/sequelcore/tesota/issues/397)'s question.
- **A model listing the cases a request leaves open**
  ([#397](https://github.com/sequelcore/tesota/issues/397)), measured
  before anything is built (`evaluation/open-cases.ts`). Requirements
  studies report that models find most ambiguities but flag about half of
  clear requirements too, so false alarms decide it. Six requests from
  #387's runs, four with a registered open case and two controls that
  settle every case (`LEFT_OPEN`), 5 repeats each, given the request alone
  or the request and the file one run wrote. Registered thresholds: at
  least two thirds of the open cases found, and at most one false alarm, a
  listed case the request settles, per control request. Labelled with
  model and setup hidden, by the same labeller as #387:

  | Model, context | Open cases found | False alarms per control | Cost of 30 calls |
  |---|---|---|---|
  | GPT-6 Luna, request | 19/25 | 2.2 | $0.003 |
  | GPT-6 Luna, request and file | 11/25 | 0.0 | $0.002 |
  | GPT-6 Sol, request | 25/25 | 0.2 | $0.05 |
  | GPT-6 Sol, request and file | 25/25 | 0.8 | $0.07 |

  GPT-6 Sol met both thresholds, but listed about 2.8 cases per request, of
  which about one was a registered open case; 38 of its 85 were inputs the
  request never mentions, such as NaN, Infinity or -0, which an operator
  would have to read past. Shown the file, Luna found fewer open cases. No
  receipt section is built from this alone.

  On eight new requests (`HELD_OUT`), with a rule added to the prompt to
  leave out inputs of a kind the request never mentions, GPT-6 Sol, 5
  repeats, found 30 of 30 open cases and listed 0.30 unusual inputs per
  request, against 1.3 before. By the labeller's reading it listed 1.15
  false alarms per request that settles every case, above the threshold of
  1; 21 of the 23 came from one request, `fullName(first, last)` "joined by
  a single space". Twelve of those asked what an empty first or last name
  gives. The owner had the labeller rule by industry practice: the W3C's
  [Personal names around the world](https://www.w3.org/International/questions/qa-personal-names)
  says not to require a family name, since many people have only one, so
  an empty part is a real input and `"Ada"` against `"Ada "` is open. The
  nine about spaces around a name stay settled. That ruling, made after
  the result was seen and by the labeller, brings the false alarms to 0.55
  per request and the list within every threshold; without it the list
  fails.

  The owner was unsure of that ruling, so six more requests that settle
  every case (`SETTLED`) were registered before any run, with the labelling
  rule fixed first. Over 30 answers Sol listed 19 cases, 0.63 per request
  even if every one were a false alarm, so the list passes on them without
  a ruling: nothing for four of the six requests; for the other two, an
  empty array the request rules out, and how to capitalize `"hi!"`, the
  Turkish "i" and the German "ß".
- **Findings turned into tests** ([#375](https://github.com/sequelcore/tesota/issues/375)),
  measured before anything was built. GPT-6 Sol and Luna reviewed 20 bugs
  from SWE-smith's JavaScript set (`bun run swesmith:eval`), each as a change
  and beside a control, the bug's exact fix. Luna turned each finding into a
  test that must fail on the change, then fixed the code so the test passes
  without breaking the visible tests; the bug's own failing tests stayed
  hidden as the oracle. Sol labeled the bug findings, unaudited.
  - Both reviewers caught 20 of 20 bugs, at precision 0.96.
  - A failing test alone confirmed 12 of 21 findings on the correct
    controls; none of those tests passes on correct code.
  - With the fix step, 10 of those 12 still passed, since their fixes changed
    behavior no test covers. Real findings fell to 13 of 20 bugs a reviewer:
    about half of the tests also failed on correct code, so no correct fix
    could make them pass.
  - Gate and fix cost 7.1M tokens, against 1.7M for the reviews.

  Running code shows what the code does, not that it is wrong: a test the
  agent derives from a finding encodes the agent's opinion. On the
  registered review cases from `d0c03f66` (`bun run findings:eval`) the
  reviewers reached the same ceiling and the gate confirmed all three of
  Sol's false findings. Jev, as triage of the gate below 0.2, skipped nothing:
  every finding described behavior. The cases are mechanical bugs, 20
  instances, with one agent model.
- **A reviewer that proposes checks** ([#397](https://github.com/sequelcore/tesota/issues/397)),
  on the same 20 bugs and 20 controls, measured before anything is built.
  - **Sources:**
    - a reviewer that writes only cases in the request's words, each with a
      test, or gaps (`--stage=checks`, Claude Sonnet 5.5);
    - Claude Code's local `/code-review` and Sol's findings from #375, each
      turned into such cases by Sol.
  - **Approvers:** an approver stands in for the operator. The perfect approver
    approves a case when its test passes on correct code. Claude Opus 5.5
    judges blind, from the request, the diff and the case. A case approved and
    failing on the change is evidence; on a control it is false.

  | Source | Bugs caught, perfect approver | Bugs caught, Opus | Controls with false evidence, Opus |
  |---|---|---|---|
  | Cases reviewer | 17/20 | 18/20 | 5/20 |
  | `/code-review`, then cases | 20/20 | 20/20 | 6/20 |
  | Sol's findings, then cases | 16/20 | 16/20 | 6/20 |

  - **With the perfect approver, no source gave false evidence.** Opus approved
    all 11 of the cases reviewer's cases whose test fails on correct code, so a
    model cannot stand in for the operator.
  - **Cost:** the cases reviewer took one step, 1.8M tokens for 40 changes, and
    wrote cases on 11 of the 20 controls. Writing cases from the other two
    sources' findings took 10.3M tokens, and `/code-review` itself cost $4.04.
  - **Not measured:**
    - a person approving cases;
    - Opus on 36 of `/code-review`'s 91 bug cases;
    - contracts, which SWE-smith's JavaScript libraries cannot carry.

  One ultrareview run, on one control, reported nothing.

  **Two refinements of the judge,** registered after that result:
  - **The judge never sees the change.** Models shown code tend to encode what it does, not what it should do. The judge sees the request and what the request makes the specification: for a refactor, the files before the change. It may also answer that the request leaves the case unsettled, with the question it would ask (`--prompt=2`).
  - **A separate check that each test checks its case:** Sonnet reads the case and its test (`--stage=faithful`).

  | Controls with false evidence | Cases reviewer | `/code-review` | Sol |
  |---|---|---|---|
  | Opus, shown the change | 5/20 | 6/20 | 6/20 |
  | Opus, no change, may ask | 5/20 | 4/20 | 5/20 |
  | and the test checks its case | 5/20 | 2/20 | 4/20 |

  - **Asking caught about half of the wrong expectations it touched.** Opus asked 25 questions: 13 on cases whose test fails on correct code, and 12 on cases that were right.
  - **It still approved 25 such cases as following from the request.** On the cases reviewer's bugs it kept 18 of 20, then 16 with the test check.
  - **The test check is weak.** It flagged 16 of the 71 cases whose test fails on correct code, and 18 of 210 that pass.
  - **The remaining false evidence needs knowledge of the project or its environment:** an exact timestamp that depends on the time zone, or how a library renders context. No judge that sees only the request has that knowledge.

## Credits

Proofs run on [LemmaScript](https://github.com/midspiral/LemmaScript) by
Midspiral (MIT), a runtime dependency, with
[Dafny](https://github.com/dafny-lang/dafny). The round-trip check adapts
the method and prompt wording of
[ClaimCheck](https://github.com/metareflection/claimcheck) by metareflection
(MIT); [NOTICE](../../NOTICE) keeps its license.
