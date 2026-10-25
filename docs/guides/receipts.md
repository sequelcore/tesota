# Receipts

A receipt is what a run proved, tested, couldn't verify and may have
weakened, kept with the session. `tesota receipt` writes the last one for a
pull request or for CI.

When you answered the agent's questions, the receipt keeps those answers
as request context, separate from evidence and acceptance. The shell shows
their count; Ctrl+O expands the questions, choices you selected and your
text. Exported Markdown and JSON retain this context too.

## Model graph previews

The transcript shows a model's captured graph without expanding the receipt:
up to six diagram rows, using the counterexample path when TLC reported one,
or the reached graph when it fits. Arrows in the reached graph list concrete
successors; they do not turn the whole graph into one execution. State numbers
follow the order of states in the `.txt` artifact. `!` marks a state TLC
reported as violating an invariant. Full valuations and action labels stay in
the files.

Reached and reported-violating counts describe the captured exploration.
Partial exploration labels both counts as lower bounds. Zero reported
violations is not a safety verdict. A missing or limited capture says so;
the graph never changes the verification verdict.

**Open graph** names the `/graph <name>` command that opens the capture
full-screen, then `o` inside it for the browser; its `.dot`, `.mmd` and `.txt`
files stay beside the session. A
preview that does not fit has no scroll region of its own: open the graph.

`/graph` opens the newest graph the shown session's receipts captured, or the
one it names, over the conversation. Arrows and drag pan; `+` and `-` choose
one of three detail levels; `g` groups by up to two variables; Enter drills
into the selected group; `n` and `p` jump between reported violating states;
`t` shows TLC's concrete trace, the only execution shown; `/` searches the
reached states; Tab moves the selection, and the side panel shows the selected
state's full variables. Esc closes a prompt, leaves a drilled group or the
trace, then closes the viewer, returning to the same place in the conversation
with the draft kept. A question that arrives while it is open waits under it.
Counts follow the capture: a partial exploration's are lower bounds.
`/graph --plain`, the inline shell, and a terminal smaller than 40×12 append
the graph's text rendering to the conversation instead.

### Explore a capture in the browser

Use `/graph` for the newest capture, or `/graph <name>` for a named one,
then press `o` in the text viewer. It writes a self-contained HTML file beside
the capture, shows its absolute path in the viewer's status line and opens
the system browser. Nothing stays running in Tesota to serve the page.
If opening the browser fails, the written path stays in the status line.

For SSH or headless use:

```sh
tesota graph --html /path/to/capture.manifest.json
```

This prints `/path/to/capture.html` without opening a browser.
Copy the file to a machine with a browser and open it directly. All code,
Cytoscape.js and graph data are inline: no server, CDN or network is needed.
The file contains the full captured variables; treat it like the capture
when sharing it. Writing it again replaces the HTML file.

Beside a broken rule, **Rule, from the model:** shows its captured TLA+
definition as text, not an English interpretation. Definitions longer than
400 characters end in `…`. A definition is omitted when it cannot be found
unambiguously in that model file or its content binding cannot be checked.
The text viewer shows the same definition under the selected state's `! BREAK`.

The page uses the same grouping and conserved counts as the text viewer.
Choose up to two variables, expand or fold groups, inspect each state's
variables, or search by state, action, property or value. `! BREAK` counts
reported violating members; it does not label every member of a mixed group
as violating. Partial counts remain lower bounds, and zero reports never
establish safety. Toggle TLC's concrete trace to see the only execution
shown, with its steps and changed variables. Mouse pan and zoom, arrow keys
and `+`/`-` with the graph focused, and system light/dark themes work offline.

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
[Receipt v2](../receipt-v2.md) specifies every field.

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
- [Receipt v2](../receipt-v2.md)
