# Your first session

This walk-through uses a small JavaScript project with a test command. Any
Git repository works the same way.

## 1. Open Tesota in the project

```sh
cd my-project
tesota
```

The footer says what Tesota can verify here:

- `● ready · proofs and tests`: the project has LemmaScript contracts and
  check or test commands;
- `● ready · tests only`: it has commands but no contracts;
- `● ready · nothing to check with`: it has neither. Tesota still lists
  what changed as not verified.

## 2. Ask for a change

Type the request and press Enter:

```text
Take 10% off orders over 100, and add a test for it.
```

The agent reads, writes and runs commands. By default Tesota asks before
anything that isn't a read: answer **Yes, this once**, **Yes, for this
session**, or **No**. Shift+Tab switches to full access or read only;
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
  <img alt="A verified turn: the request, the agent's two file writes and its answer, then Tesota's receipt saying nothing needs you, the tests pass and the new test notices the change." src="../assets/tesota-turn-dark.svg">
</picture>

- The first row says whether anything needs you: `✓ Nothing needs you`,
  `○ Nothing needs you · 1 unverified` in amber when something is left
  unverified, or `! 2 things need you`.
- Then what is unverified, and one row of what holds: here, the tests pass
  and the new test notices the change, since it fails without it. It
  notices it by what the agent expects, so the receipt says the test was
  added in this request.
- Press Ctrl+O for each finding's details; again to fold them.

The footer keeps the receipt in brief, in the same color: `○ receipt · tests
pass · 1 file not proved`.

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
- [Sessions](../guides/sessions.md): several requests at once, each in its
  own worktree.
