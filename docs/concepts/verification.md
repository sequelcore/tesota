# How verification works

When the agent says it's done, Tesota's gate checks the change before the
run may end. Each rung answers a narrower question than the one before, and
the receipt keeps their answers apart:

1. **Proved.** The changed file's LemmaScript contracts hold for every input
   they admit (LemmaScript with Dafny).
2. **Tested.** The project's own commands pass with the change.
3. **Exercised.** A changed or added test fails without the change.
4. **Strong enough.** Small changes to a proved function's body break its
   proof, unless Dafny proves they behave the same.
5. **Model-checked.** A model of the design the change touches holds its
   invariants in every reachable state, and each planted fault breaks one
   (TLC). This is evidence about the model, not a proof of the code.
6. **Judged.** A model compares each new contract with the request. This is
   a model's judgment and never counts as a proof.

Alongside the rungs, the receipt lists what may weaken the evidence and what
nothing verified, down to changed lines. Tesota verifies results, not
actions: what the agent may do is the [permissions](../guides/permissions.md)'
job.

| Behavior | Owner |
| --- | --- |
| The gate and its order | `src/gate.ts` |
| Request fingerprints and attribution | `src/request-fingerprint.ts` |
| Evidence and its content hash | `src/evidence.ts` |
| Proofs and `prove` | `src/verification/lemmascript-verifier.ts`, `src/prove-tool.ts` |
| Weakened evidence | `src/verification-changes.ts` |
| Tests and exercise | `src/projects.ts`, `src/test-rung.ts`, `src/test-report.ts` |
| Contract strength | `src/proof-guarantees.ts`, `src/proof-mutation.ts`, `src/pi-claimcheck.ts` |
| Models and `check_model` | `src/model-check.ts`, `src/model-tool.ts` |
| Open cases | `src/open-cases.ts` |
| Coverage | `src/proof-coverage.ts` |
| The receipt and `tesota receipt` | `src/receipt.ts`, `src/pull-request-receipt.ts` |
| What you see of it | `src/footer.ts`, `src/messages.ts`, `src/editor.ts`, `src/prove-tool.ts`, `src/model-tool.ts` |

## Evidence

Each check produces an **evidence** record: which verifier ran
(`lemmascript`, `command` or `tlc`), the claim a pass establishes, what it
doesn't, how it ended, the end of its output, its duration, the files it
checked and a SHA-256 of their paths and content. Evidence describes those
files only while their content still has that hash.

Outcomes are `passed`, `failed`, `vacuous`, `timed_out`, `cancelled` and
`not_started`. A proof passes only when LemmaScript regenerated and checked
it cleanly and Dafny verified at least one obligation; a clean run that
verified nothing is `vacuous`, never proved.

## The request and its base

A request starts with your input. Before the agent can run anything,
Tesota records the request's **base**: the commit `HEAD` names. A steer or
follow-up joins the request already running; what the gate sent back
resets on your next request.

At the first non-reader tool's `tool_execution_start`, before the tool runs,
the gate fingerprints each repository: its `HEAD` and the blob IDs of every
dirty path, including deleted, renamed and untracked files. It uses
`git status --porcelain=v2 -z --untracked-files=all` and
`git hash-object --stdin-paths`, without `-w`; optional index refreshes are
disabled. It writes no objects, refs, index or stash. A new request resets
the fingerprint; steers, follow-ups and verification continuations keep it.

At settlement it captures again. A repository is eligible if `HEAD` moved,
a path appeared, disappeared or changed blob, or any path was unmeasured.
The request's changed paths are those differences plus the files changed
between the admission base H and the current `HEAD`, deletions included.
These are **changed during the request (by anyone)**: the gate observes
results, not authors. A stash removing old dirt counts as a request change,
even when it restores H's content. A commit hides nothing.

Paths dirty at the start whose blob stayed the same are **inherited**.
They are not proved or exercised as this request's change. Dirty files over
10 MiB and files in an untracked directory with 200 or more files are
**unmeasured**, never unchanged. Git failures or index conflicts make a
capture **unknown**, with a reason; verification then uses the whole change
against H and the receipt explains why attribution could not be measured.

**Outside a repository** the base is Tesota's own snapshot of the folder,
taken as the request starts: Git, with its Git folder in
`~/.tesota/snapshots` and your folder as its work tree, so your folder
gains nothing. An OS lock gives the snapshot store one writer across
processes, from initialization through commit and pruning.
Secrets (`.env`, `.env.*`), Git's and Jujutsu's folders,
dependencies, build output and what `.gitignore` names are left out; a file
over 10 MB is left out and listed as not verified. A folder of more than
20,000 files or 3,000 folders, or that takes over 5 seconds to read, a home
folder and a drive's root are never snapshotted: there, a request that may
have changed files ends with a receipt saying why they weren't verified.

**A folder of repositories** is verified repository by repository: each
one's base is its own commit, and the gate runs in each repository the
request changed, with its own commands. One receipt holds each one's
evidence in its `units`. In a home folder or a drive's root, only the
repositories are units: the other folders there hold a person's files, and
none of them is snapshotted.

## The gate

The gate runs when a run completes. It verifies only when a tool that may
change files started during the request: any tool except the built-in
readers `read`, `grep`, `find` and `ls`. `prove` counts because it regenerates
proof files. Nothing counts in a read-only session, such as a subagent that
only reads: only tools that read start there, and its own subagents only
read, so its gate never verifies edits it didn't make, such as its parent's
in the folder they share (#585). Without such a start, the footer returns to ready, with no
checks, model call, diff or receipt. If no unit's fingerprint is eligible,
it also returns to ready without checks, an open-cases call or a receipt.
Eligible units climb:

1. Prove each changed TypeScript file with `//@` annotations, and each whose
   `.dfy` or `.dfy.gen` changed. A proof maps back to its source as
   LemmaScript maps it: beside it, or under the `proof-dir` a project's
   `lemmascript.json` sets.
2. Once no proof goes back, run the project's commands.
3. Once no command goes back, measure each new or changed contract's
   strength, and send back the weak ones.
4. Once no contract goes back, check each model whose own files or covered
   files the request changed, and send back those that fail.
5. When nothing goes back, settle with the receipt.

Stopping the run while it climbs ends the step under way and every process
it started, and starts no other: the receipt says you stopped it and claims
no evidence.

**What goes back** follows one rule on every rung (`gateVerdict`, proved).
A `failed` or `vacuous` result goes back to the agent, unless it repeats a
failure already sent for the same file, command or contract during the
request: then it's `no_progress`, reported instead of sent again. A result
that couldn't run, ran past its limit or was stopped is yours, and never
goes back. What counts as a repeat:

- **Proofs:** the outcome and output.
- **Commands:** the set of failing tests, from the JUnit XML reports the
  command wrote. A command that writes none goes back once, since its
  output varies between runs.
- **Weak contracts:** the surviving mutants.
- **Models:** the counterexample's steps, the planted faults' verdicts, or
  what TLC printed. A file without a header goes back once.

## Proofs

Tesota runs LemmaScript's `lsc` in the project itself: `lsc regen` merges
the changed source into the file's `.dfy`, keeping proof lines written by
hand, then `lsc check` proves it with your Dafny. Each process has 5
minutes; Tesota stops it with everything it started.

**`prove`** gives the agent the same on one file while it works. It's off
until the session finds a file with `//@` annotations, or the agent writes
one. It runs alone, so its evidence describes files no other call left
half-written. Its guidance asks the agent to work until the proof passes,
gives LemmaScript's syntax, and forbids loosening a contract or adding
`//@ assume`.

**On trust.** A pass reads `Proved` only when nothing in the proof is
taken on trust or left out: no `//@ assume`, `//@ extern` or `//@ skip`, no
function a `//@ verify` leaves out, and no `assume`, `{:axiom}` or lemma
without a body written into the `.dfy` by hand. Otherwise it reads `Proved,
but not outright` and names each one.

**Skipped lines.** LemmaScript skips a specification line without a word
unless it reads `//@ <keyword> <expression>`, one space after `//@` and
one after the keyword. Such a line belongs to no contract; `prove` names it
and asks the agent to rewrite it.

## Weakened evidence

From the diff against the base, fixed rules list the changes that may
weaken the evidence. The agent can't argue one off the list; whether each
is legitimate is yours to decide. Moving or reindenting a line doesn't count.
This still includes inherited paths, so weakening left by a stopped or
unverified earlier request remains visible when a later request changes files.

- **Contracts:** a removed or changed `//@ requires` or `//@ ensures`.
- **New preconditions:** a `//@ requires` added to a function the base had.
- **Assumptions:** an added `//@ assume`, or `//@ extern`, which trusts a
  function's contract without proving its code.
- **Left out of the proof:** an added `//@ skip` on something the base had,
  or a function the base proved that a new `//@ verify` leaves out, since
  LemmaScript then extracts only the functions marked.
- **Dafny proofs:** an `assume` or `{:axiom}` line, or a lemma without a
  body, written into a `.dfy` by hand. A line LemmaScript generated, which
  its `.dfy.gen` holds, doesn't count.
- **Tests:** a deleted test file, or an edit that may weaken its tests: a
  removed line that isn't blank, a comment, a widened import or an extended
  line; or an added focus or skip marker (`.only`, `.skip`, `xit`,
  `@Disabled`, `#[ignore]`, `t.Skip`, `pytest.mark.skip`…), setup or
  teardown hook, or module mock. A new test file, or one that only gains
  tests, isn't listed. A line added inside an existing test, such as an
  early `return`, isn't caught.

  An extended line is one in a JavaScript or TypeScript test file that the
  added line in its place keeps token for token, adding only whole list
  items such as arguments, properties or parameters: `{ sessionId }` becoming
  `{ metadata, sessionId }` (`addsItems`, proved). It still counts when
  either line is inside an assertion's call (`expect`, `assert`, `should`),
  or when the line holds or gains a word that checks, skips, defines, retries
  or times a test or returns early (`toBe…`, `skip`, `only`, `it`, `retry`,
  `timeout`, `return`…), or a comment or open string that could hide the
  lines after it.
- **Check scripts:** a `package.json` script selected at the base whose
  command changed or is no longer selected.

A proof whose source or `.dfy` gained an assumption holds only if what the
change trusts is right, so the receipt never calls it proved outright:
`Proved, trusting 3 unproved parts`.

When the diff passes 16 MiB, the receipt says the change wasn't checked
for weakening, and coverage isn't measured.

## Tests

Tesota finds the projects in the repository, at the root and up to three
folders below, and their commands:

| Project | Commands |
| --- | --- |
| JavaScript or TypeScript | `check`, or else `typecheck`, `lint` and `test`, with the package manager `package.json`'s `packageManager` field names, else the lockfile's, else the first of npm, Bun, pnpm and Yarn on the `PATH` |
| Gradle | `check`, through `./gradlew` when present |
| Maven | `verify`, through `./mvnw` when present |
| Cargo | `cargo test` |
| Go | `go test ./...` |

The gate runs the commands of the deepest project holding each changed
file (`owner`, proved), from the root through `cd <folder> &&`, in a POSIX
shell: Git's bash on Windows, bash elsewhere. Each has 15 minutes. It reads
the failing tests from JUnit XML reports written under the project while
the command ran.

**Exercise.** When every command passes and the request has a base, each
changed or added test file in a programming language runs alone over the
base (a snapshot or a JSON fixture is no test a runner runs), in a Git worktree in
the temporary folder with the checkout's `node_modules` linked in. What
runs it there (#603): when the project's `test` script directly runs Bun,
Vitest or Jest with plain arguments, that script on the file alone, with
per-test reporting and the runner's empty-suite success flag, even when a
composite `check` is the project's normal command; Bun and Vitest write
JUnit XML, Jest its native JSON report. Jest takes the file as an exact
path (`--runTestsByPath`), which keeps the project's own selection. Bun
and Vitest take it as a filter, which also selects every path that ends the
same way: Bun's exact form, `./`, runs files the project excludes, and
Vitest has none. So the reason names any other file the runner ran tests
from on the base (#620). Otherwise the project's whole commands run. Each
reason names the command that judged it.

- a test that passes there passes on the base: it doesn't depend on the
  change, though it may still guard against a regression. For the runner
  on the file alone, a pass counts only when its report, read whole, holds
  a test from that file, named by its path, that ran and passed: a filter
  that selects nothing passes with no tests, so an exit alone shows no
  test ran (#615). A report holding fewer or more tests than its root
  counts gives nothing;
- a test that fails there, while the base passes without it, notices the
  change: it fails, then passes (`checkOrigin`, proved). Without it means
  the base's own version of the file, or none, for the runner on the file
  alone, and the base as it is, once per project folder, for the whole
  commands;
- when the base fails without it too, the reports of both runs decide: the
  test notices the change when tests fail with it that pass, or are
  missing, without it, as SWE-bench grades fail-to-pass;
- what ran it must also pass with the whole change, run once per project
  folder in the same worktree, so that both sides lack the same files the
  repository ignores: a base that fails for want of a vendored binary
  isn't a defect the change repaired (#618). The runner on the files alone,
  when another file fails there, runs once more on the file alone, and must
  run a test from each file it credits that passed;
- anything else stays unknown, with the reason.

The runner on one file sees what the test asserts, not the project's
typecheck or lint of it, which the change's own commands already passed.

The receipt keeps that apart from the test's provenance (#527): whether the
base held the file, so the request changed it, or the request added it. A
test the agent added notices the change by what the agent expects, which
may be wrong (#396), so neither fact is a score of how much to trust it.

A change to `package.json` or a lockfile leaves the base with the wrong
dependencies, so no run there gives a verdict.
Commands run on the real working tree, including inherited changes.
Exercise still uses H as its base: a test relying on inherited changes may
be misjudged, which the receipt discloses.

## Contract strength

A contract is a top-level function's `//@` lines, where LemmaScript reads
them. Once the commands pass, each contract the request added or changed in
a file that proved is measured two ways at once.

**Mutation** proves up to 8 small changes to the function's body, each
alone: return another of its returned values, flip a comparison, move a
number by one, swap `+` and `-`. A mutant whose proof fails is ruled out by
the contract; one that still proves is a **survivor**. This is Lahiri's
completeness metric (FMCAD 2024), with the prover in place of tests.

**Equivalence** then asks Dafny whether a survivor returns the same result
as the code for every input the `requires` admit. One proved equivalent is
only counted. A contract with survivors left is **weak**, and goes back to
the agent to be strengthened while staying provable.

**ClaimCheck** adapts [ClaimCheck](https://github.com/metareflection/claimcheck)'s
round trip, in two separate requests: a model restates each contract
without seeing the request (`--claimcheck-model`, or the session's), then
the session's model compares the restatements with what you asked. The
verdict is `justified`, `partially_justified`, `not_justified` or
`vacuous`. It's a model's opinion: it never goes back and never counts
toward what needs you.

Sending weak contracts back made the final contract rule out the
registered bug in 15 of 15 runs, against 2 of 15 with the receipt alone
([#351](https://github.com/sequelcore/tesota/pull/351),
[#353](https://github.com/sequelcore/tesota/pull/353)).

## Models

A proof covers a function for every input it admits; a race between
concurrent steps is out of its reach. A model of the design is checked
instead, with TLC, which explores every order of the model's steps.
Experiment [#539](https://github.com/sequelcore/tesota/issues/539) chose
TLC: it found every race in 12 to 16 seconds, where Apalache reached none
within its budget.

**Which files are models.** A `.tla` or `.qnt` file in the project whose
comment holds the `tesota-model` header: the files and functions it covers,
the commit it was last confirmed against, its invariants, the steps it
treats as atomic, what it leaves out, its planted faults, and optionally a
replay command. One format for both languages, read from comments, so no
reader per tool. [Verification](../guides/verification.md#model-check-it-tla-and-quint)
shows it.

**When a model runs.** When the request changed the model, its
configuration, one of its faults or a covered file, once before the run
settles, unless the session already passed the same content
(`checksModel`, proved): the evidence binds the SHA-256 of all of them.

**How it runs.** A TLA+ model runs TLC 2.19 from `tla2tools.jar` on its
`.cfg`, with the header's invariants added, from the specification's
folder, with a 2 GB heap and a temporary folder for TLC's state. A Quint
model runs `quint typecheck`, then `quint verify --backend=tlc` with the
header's invariants. Each run has 5 minutes, the proof timeout; a model
with F planted faults takes at most (F + 1) × 5 minutes. A missing Java,
TLC or Quint, and Quint failing to start Apalache, as on Windows under
Node 24, are runs that didn't start: the receipt says the model wasn't
checked, and the run never fails for it.

**How it ends** (`tlcRun`, proved): TLC's exit 0 with a reachable state
passes; 10 to 14 is a violation (assumption, deadlock, invariant,
liveness, assertion); 150, 151 and 75 mean TLC couldn't read or evaluate
the model; anything else means TLC didn't run.

**Planted faults** (`faultVerdict`, `modelOutcome`, proved). Once the
model passes, each fault runs with the same invariants. A fault is caught
only by a violation. A model with no fault, or a fault that passes or that
TLC can't read, goes back: nothing shows the model can tell a fault from
the code. Tesota runs the faults a model declares; it doesn't mutate
models itself.

**A counterexample** goes back as numbered steps, each the action TLC
names, which a model true to its code takes from the code, with the
variables it changed. The agent is told to replay it against the code:
every step possible means a bug in the code; one impossible means a wrong
model; and never to weaken an invariant.

**`check_model`** gives the agent the same check on one model while it
works, through the gate's own code (`checkModel`), faults and replay
included. It's on once Tesota finds `tla2tools.jar`, so its guidance,
which says TLC is installed and gives the header, never claims a TLC that
isn't there. It runs alone, as `prove` does. Without that, pstack's skill
judged TLC unavailable and wrote an interleaving test instead of a model
(#554). The gate still checks the model before the run settles.

**What the receipt adds** to a pass:

- the abstraction: the covered files, the atomic steps and what's left
  out, since what a model can find is fixed by them; #539's one miss lay
  exactly in what its model left out;
- "not linked to the code", unless the header's `replay` command passes;
- "possibly stale" when a covered file differs from the `confirmed` commit
  (`staleness`, proved), or "staleness unknown" when that commit isn't in
  the repository: a hint, never a guarantee, since a change outside the
  covered files can break what the model assumes;
- "written with the code", which counts as weaker, when the request changed
  both the model and the code it covers (`writtenWithCode`, proved). Such a
  model that passed was checked against the code as the request leaves it,
  so it is never called stale; a later request that changes the covered
  code without the model gets the hint again.

A model checks the properties it's given. Open cases still apply after a
pass.

## Open cases

A proof settles code against its contract, not the contract against what
you meant, and agents settle a request's open cases silently. So as the run
settles, a model reads your messages for the request, not the change, and
lists the inputs where someone who made the request could expect more than
one result. A standard term keeps its usual meaning unless you say otherwise,
so `clamp` or `median` raise no case their definition settles, while an
input their definition gives no result for, such as an empty list, still
does. The receipt shows each as a note for you to settle; nothing goes back.

The model is GPT-6 Sol, the one that found every open case with few false
alarms on held-out requests
([#397](https://github.com/sequelcore/tesota/issues/397)), or
`--open-cases-model`; `off` turns it off. When the model isn't available,
or takes more than 2 minutes, the receipt says why nothing was listed. If
listing depends on an issue, PR, file or other reference whose relevant
contents aren't in your messages, the model reports what is missing instead
of guessing its cases. The lister cannot fetch references; include their
requirements in the request to have it list them.

## Coverage

A file that proved covers only some of its changed lines. A line is covered
when it's inside a function with a contract, from the first annotation to
the closing brace, and the change didn't narrow that contract
(`proofCovered`, proved). Blank and comment-only lines don't count, read by
each language's own parser: TypeScript and JavaScript by theirs, Python
and Go by tree-sitter grammars Tesota ships. In any other language, a
changed comment counts as code: more listed, nothing missed.

A changed file no proof covers is listed whole, unless it's a test file or
its change is only blank lines and comments. Both lists read "not proved"
when the commands passed, and "not verified" otherwise.

## The receipt

When nothing goes back, the run settles with a `tesota-receipt` session
entry. It records the base, when the request started and settled,
Tesota's version and the model; each proof with its verdict and evidence;
each measured contract; ClaimCheck; the open cases; each command; each
exercise finding; the weakened evidence; what nothing verified; and the Git
blob of every file changed during the request (by anyone), inherited paths,
unmeasured paths and capture states.
[Receipt v2](../receipt-v2.md) specifies every field, and
[Receipts](../guides/receipts.md) how `tesota receipt` writes it for a pull
request.

## What you see

- **The footer** shows what the project lets Tesota verify before a
  request (`readiness`, proved), that it waits while the agent works, the
  gate's step and timer while it verifies, and the receipt in brief after.
  It names no file or command: the status line does.
- **The status line beside the orb** says `Working…` while the agent works.
  While the gate verifies it names the operation running, its exact
  launched command or target, and the time it has run, such as
  `Running project check · bun run check · 6:02`. Operations the gate and
  its runners publish from the code that runs them (`src/operations.ts`)
  feed it: each has a start and an end the runner reports, never an
  estimate, so it shows no percentage or time remaining. Concurrent work
  (mutation with ClaimCheck) shows as concurrent, a reused check as reused,
  a stop marks unlaunched work as not started, and an operation with no
  end reads as interrupted, never passed. When none runs it says
  `Verifying…`. It listens only while shown, and lets go when the session
  switches or the shell stops.
  It leads with `!` when anything needs you, by the same count as the
  receipt, `○` when nothing does but something is unverified, and `✓`
  otherwise, in the receipt's color. It is one row: at the right the
  folder, the model, the context % and the permission mode. As the terminal
  narrows it drops the folder, then the model, shortens the evidence, then
  drops the context % (`footerLayout`, proved); the permission mode stays.
- **The request's block** is one block at the end of the conversation.
  While the gate verifies it is a ledger read from the same operations:
  the operation running, up to three that ended most recently, each with
  its glyph and time (`✓` passed, `✗` failed, `◐` verified nothing, `○`
  ended without a verdict, such as not started, past its limit or with no
  end), a count of the earlier ones, and each attempt that went back to the
  agent folded into `↺ Attempt 1 · returned to agent`. Ctrl+O shows every
  check of every attempt. When the run settles the receipt takes its place.
- **The receipt** is built from the receipt's `details` (`receiptSummary`),
  as the card, as plain text and, separately, as Markdown, so no Markdown
  escape reaches plain text. It opens with its counts, failed checks, review
  flags and verification limits, counting only findings the checks
  established (`decisions`, proved), and `Check evidence, not your
  acceptance.` Its color is green only when there are no flags and no limits,
  amber otherwise, red when a check failed (`verdictTone`, proved). Then one
  row per method (Tested, Proved, Models, and Exercised or Contracts when
  something held), each saying only what ran and how it ended, `✓` only
  when every run held outright (`methodStanding`, proved): a passing
  model reads `model-checked`, never proved; a proof resting on assumptions
  the change added reads `◐ … trusting 3 unproved parts`. Then the review
  flags and the limits, findings of the same reason grouped into one row,
  such as `! Review test edits · 2 heuristic flags`. The models' opinions
  (ClaimCheck, open cases, marked `◇`) follow under their own heading and
  are never counted. `▸ Details` holds every path, output and assumption;
  `▸ Context` the operator's answers, inherited files and subagents, whose
  receipts cover their own branch, never the parent's change. Rows wrap; a
  reason is never cut.
- **What the gate sends back** is a card titled with what failed, such as
  `↺ Sent back to the agent: the tests fail`.
- **`prove`** shows the file, how long the proof took, and `✓ Proved` or
  `✗ Not proved` with Dafny's error and the contract line it points at.

Ctrl+O expands each one to its details.
Inherited paths occupy the receipt's Context row, with their paths under
Ctrl+O. Unknown capture states show their reasons.

## Proved rules

The pure decisions carry LemmaScript `//@` specifications, proved with Dafny
by `bun run formal:check` on every pull request.

| Rule | Decides |
| --- | --- |
| `proof-outcome-rule.ts` | How a proof ended, vacuous included |
| `gate-rule.ts` | Which started tools make a request eligible, what goes back, what is yours, and whether the run continues |
| `fingerprint-rule.ts` | Whether a repository is eligible and whether each path is a request change, inherited, unmeasured or unchanged |
| `weakening-rule.ts` | Which annotation changes may weaken the evidence |
| `selection-rule.ts` | Which functions LemmaScript extracts, `//@ verify` and `//@ skip` included |
| `test-weakening-rule.ts` | Which changes to a test file may weaken its tests |
| `project-rule.ts` | Which folders hold projects, and which project owns a path |
| `check-origin-rule.ts` | Whether a test failure comes from the change |
| `mutation-rule.ts` | What a mutant's proof means, and when a survivor is equivalent |
| `proof-cover-rule.ts` | Which changed lines a proof covers |
| `comment-line-rule.ts` | Whether a line holds only a comment |
| `range-rule.ts` | How the receipt groups line numbers |
| `footer-rule.ts` | What Tesota can verify before a request, and what the footer's one row drops as the terminal narrows, never the permission mode |
| `model-rule.ts` | How a TLC run ended, what a planted fault shows, how a model's check ends, when a model runs, whether it may be stale, and whether it was written with its code |
| `verdict-rule.ts` | How many findings need you, never a model's opinion, when a summary must say how many hold, the receipt's color, and when a method's row reads as holding |
| `settle-rule.ts` | Whether a run goes on or how it ends, after its extensions and its verifier |
| `permission-rule.ts` | Whether a call may run: the floor, the mode and the strongest rule |
| `reconcile-rule.ts` | What recovery says of each call of an interrupted run |
| `compact-rule.ts` | When to compact, and where the verbatim tail starts |
| `edit-rule.ts` | When a list of edits may apply to a file, all at once |
| `truncate-rule.ts` | How much of a tool's output the model gets |
| `catalog-rule.ts` | How much of the prompt the skill list and instruction files may take |
| `invocation-rule.ts` | Who may start a skill: the model unless `disable-model-invocation: true`, the operator by name unless `user-invocable: false` |
| `budget-rule.ts` | Whether a performance measurement keeps to its limit, in one of two attempts |

## Credits

Proofs run on [LemmaScript](https://github.com/midspiral/LemmaScript) by
Midspiral (MIT) with [Dafny](https://github.com/dafny-lang/dafny). Models
run on [TLC](https://github.com/tlaplus/tlaplus), from the TLA+ tools (MIT),
and [Quint](https://github.com/informalsystems/quint) by Informal Systems
(Apache 2.0); Tesota runs both as the operator installs them. The
contract comparison adapts the method and prompt wording of
[ClaimCheck](https://github.com/metareflection/claimcheck) by metareflection
(MIT); [NOTICE](../../NOTICE) keeps its license.
