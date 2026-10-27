# Print mode

`tesota -p` runs one request without the shell, for scripts:

```sh
tesota -p "Rename the total function to orderTotal and update its callers."
```

The agent's answer goes to standard output. How the run ended and where
its verification stands go to standard error:

```text
Completed, verified; tesota receipt writes it for a pull request.
```

It's verified like any run. `tesota receipt` then reads its receipt.
`verified` means a test, proof or model check passed, no gap remains and
nothing needs a decision. A change nothing could verify ends `unverified`
and says why; one with a gap ends `incomplete`. A run that changed
nothing, such as a question, ends `Completed.` with no claim
([Standing](../receipt-v2.md#standing)).

Provider failures write a bounded, redacted reason to standard error before
`Ended error.` Transient failures write a retry line there; Ctrl+C cancels
the wait. See [Provider errors and retries](models.md#provider-errors-and-retries)
for the retry bounds and the errors that stop immediately.

## Options

| | |
| --- | --- |
| `-c`, `--continue` | Continues this folder's most recently changed session ([Continuing a session](#continuing-a-session)) |
| `-r <session>`, `--resume <session>` | Continues the session with that id, as `tesota receipt` and `/resume` show it |
| `--model <provider>/<id>` | The model for this run; with `-c` or `--resume`, the one the session last ran on, otherwise your chosen one ([Continuing a session](#continuing-a-session)) |
| `--claimcheck-model <provider>/<id>` | See [Verification](verification.md#the-models-opinions) |
| `--open-cases-model <provider>/<id>`, or `off` | See [Verification](verification.md#the-models-opinions) |

## Exit codes

| Code | |
| --- | --- |
| `0` | The run completed |
| `1` | It didn't: it failed, was stopped, ended on a question, no model is set, or the session to continue isn't there or is open elsewhere |
| `2` | Arguments it doesn't take, or `-c` together with `--resume` |

Ctrl+C, or a termination signal, stops the run and lets go of everything it
started before exiting.

## What it may do

No one is there to answer a question, so print mode runs with your saved
permission mode and refuses any call that would ask. In the default mode,
ask, that means it reads but doesn't write. To let it write, choose full
access in the shell with Shift+Tab, or allow what it needs with
[permission rules](permissions.md#rules).

Your hooks and MCP servers run. The project's run only once you've trusted
them in the shell; print mode says when it leaves them out.

`ask_user` returns that no answer is available immediately. It never reads
standard input or treats the agent's recommendation as your choice. The
run ends incomplete, verifies what it changed, and its last line says how to
answer:

```text
Awaiting your answer: tesota -p --resume 2026-10-25T07-48-31-933Z-51024fc1 "<answer>"
```

## Continuing a session

`tesota -p -c "<text>"` continues this folder's most recently changed
session, and `tesota -p --resume <session> "<text>"` the one with that id.
The session file grows; no new session starts. A session another Tesota
holds open is refused with the lock's message.

The run continues on the model the session last ran on, account included
(`claude-code@b/...` stays on `claude-code@b`). A session that hasn't
replied yet uses your chosen model. `--model` overrides it, and standard
error says so: `Continuing on <new>; the session last ran on <old>.` If the
session's model can't run now, such as when its account was removed or
signed out, the run is refused with exit code 1, naming that model; choose
another with `--model`.

When the session's last run ended on an unresolved question, the text is
its answer:

- It starts a new run, with a new request number, judged from the same
  base as the request it continues. Its request carries that request's
  text, says which run it continues, and adds your answer. Verification
  judges it with that request's amendments and clarifications, then the
  answer.
- The answer is recorded as a clarification of the questions that were
  left open, the same text for each of them, the way you'd answer several
  questions in one message. A question asked in prose is a batch of that
  one question. The receipt lists it under the request's clarifications.
- An answer clarifies the request. It never grants permission: your
  permission mode, your rules and Tesota's floor stay as they are.
- What the run changed before its question still counts as the request's
  own: the run that ended on the question saved its start fingerprints in
  the session, and the new run measures from them. What verification sent
  back before starts over.
- The new run is verified at its end and gets its own receipt.

Otherwise, the text is a follow-up: a new request, as the shell sends a
message once a run has ended. So resuming twice with the same answer
answers the question once; the second time it's a follow-up.

## Related

- [Receipts](receipts.md)
- [Permissions](permissions.md)
