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

## Options

| | |
| --- | --- |
| `--model <provider>/<id>` | The model for this run; your chosen one otherwise |
| `--claimcheck-model <provider>/<id>` | See [Verification](verification.md#the-models-opinions) |
| `--open-cases-model <provider>/<id>`, or `off` | See [Verification](verification.md#the-models-opinions) |

## Exit codes

| Code | |
| --- | --- |
| `0` | The run completed |
| `1` | It didn't: it failed, was stopped, or no model is set |
| `2` | Arguments it doesn't take |

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
standard input or treats the agent's recommendation as your choice.

## Related

- [Receipts](receipts.md)
- [Permissions](permissions.md)
