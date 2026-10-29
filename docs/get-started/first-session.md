# Your first session

This walk-through uses a small TypeScript project with a test command and
LemmaScript contracts. Any Git repository works the same way.

## 1. Open Tesota in the project

```sh
cd my-project
tesota
```

The footer says what Tesota can verify here:

- `● ready · proofs and tests`: the project has LemmaScript contracts and
  check or test commands;
- `● ready · proofs only`: it has contracts but no commands;
- `● ready · tests only`: it has commands but no contracts;
- `● ready · nothing to check with`: it has neither. Tesota still lists
  what changed as not verified.

## 2. Ask for a change

Type the request and press Enter:

```text
Take 10% off orders over 100, with a contract and a test for it.
```

The agent reads, writes and runs commands. By default Tesota asks before
anything that isn't a read: answer Yes, this once, Yes, for this
session, or No. Shift+Tab switches to full access or read only;
[Permissions](../guides/permissions.md) explains each.

While the agent works, the indicator says `Working…`. Press Esc to stop it.
Type and press Enter to steer the run; Alt+Enter queues a follow-up for
when it ends. Both stay visible above the input until taken. Alt+Up (Alt+Q
on Windows) returns pending messages to the input to edit or withdraw;
stopping restores them too ([Commands and keys](../reference/commands.md#keys)).

## 3. Watch Tesota verify

When the agent says it's done, the indicator turns to `Verifying…` and the
footer shows each step: proving a file, running the tests, measuring a
contract.

If a proof fails, a test fails or a contract is too weak, Tesota sends it
back to the agent with what failed:

```text
↺ Sent back to the agent: the tests fail
```

The agent tries again. A failure that repeats one already sent stops going
back and is reported instead.

## 4. Read the receipt

The run ends with Tesota's receipt:

<picture>
  <source media="(prefers-color-scheme: light)" srcset="../assets/tesota-turn-light.svg">
  <img alt="A verified run whose change misses the request: the request for 10 off orders over 100, the agent's file writes and its answer, then Tesota's receipt with the contract proved, the tests passing and the new test noticing the change, and apart, a model's opinion that the contract covers only part of the request." src="../assets/tesota-turn-dark.svg">
</picture>

A verified run with a proof and a test reads like this:

```text
Tesota receipt
No review flags · no verification limits
Evidence, not approval: accepting the change is yours.

✓ Tested      npm test · 0:04
✓ Proved      src/discount.ts · 0:03
○ Models      none recorded
✓ Exercised   1 test file failed on the base and passed with the change
✓ Contracts   1 contract: every decided change broke its proof
```

- The first row counts what needs you. Here nothing does; when something
  is left unverified, it reads `1 verification limit`, in amber. When a
  model's opinion is worth reading, it ends with `1 opinion to read`; an
  opinion is never counted as a flag or a limit.
- Then one row per method:
  - `Tested` and `Proved`, with the command or file and its time;
  - `Models`, for [design models](../guides/model-checking.md), none here;
  - `Exercised`: the new test failed without the change and passes with
    it, so it tests the change;
  - `Contracts`: each small change Tesota made to the code broke the
    proof, so the contract is strong enough to catch it.
- Then any review flags and limits, grouped by reason, and the models'
  opinions on their own, never counted. In the image above, every check
  passes but a model finds the contract covers only part of the request: it
  takes 10 off at exactly 100, and the request said over 100. Checks that agree
  with each other can still miss what you asked; that opinion tells you
  where to look.
- Press Ctrl+O for the details: every path, output and assumption; again
  to fold them.

While Tesota verifies, the same block shows each check as it ends. The
footer keeps the receipt in brief: `✓ receipt · 1 proved · tests pass ·
contracts strong`. A `○` in its place means the run isn't verified.

## 5. Take it to a pull request

Commit the change, then, in the same folder:

```sh
tesota receipt
```

It writes the receipt as Markdown for the pull request's description.
[Receipts](../guides/receipts.md) covers the JSON form for CI.

## Next

- [Verification](../guides/verification.md): give Tesota more to check
  with contracts and test reports.
- [Model checking](../guides/model-checking.md): check a design where
  steps interleave.
- [Sessions](../guides/sessions.md): several requests at once, each in its
  own worktree.
