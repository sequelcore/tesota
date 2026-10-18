# Receipts

A receipt is what a run proved, tested, couldn't verify and may have
weakened, kept with the session. `tesota receipt` writes the last one for a
pull request or for CI.

## For a pull request

Commit the change, then, in the folder where the session ran:

```sh
tesota receipt
```

It writes Markdown for the pull request's description or a comment: the
commit and its base, the model, the session, what was proved and tested,
and what needs a reviewer. It ends by saying the receipt is check
evidence, not a reviewer's acceptance.

It also checks the receipt against the commit:

- **Stale evidence:** a proof or a test run whose files the commit no
  longer holds as they were checked.
- **Changed after the receipt:** files the commit changed that the receipt
  doesn't cover.

## For CI

```sh
tesota receipt --json
```

It writes the same receipt as an unsigned
[in-toto Statement](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md)
about the commit `HEAD` names, with the receipt as its predicate.
[Receipt v1](../receipt-v1.md) specifies every field.

## Who is accountable

Both forms name who is accountable: Git's `user.email`, or

```sh
tesota receipt --owner octocat
```

## Which receipt it writes

The last receipt of the newest session that worked in this folder and
finished its run. A run cut off before it ended counts for nothing. In a
session's own worktree, run it there.

`tesota receipt` writes nothing when:

- no session here settled with a receipt;
- the run ended, or you stopped it, before Tesota finished verifying it;
- the receipt came from a run outside Git, whose base no one else can
  fetch;
- the folder holds several repositories: run it in the repository of the
  pull request, and it writes that repository's part.

## Related

- [Verification](verification.md)
- [Receipt v1](../receipt-v1.md)
