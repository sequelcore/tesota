# Model checking

A proof covers one function; a test covers chosen cases. Neither sees
workers whose steps interleave. A design model does: a small TLA+ or Quint
description of state, steps and a rule that must hold. TLC tries every order of the steps and confirms the
rule, or shows the order that breaks it.

Use one for shared counters, locks, retries or concurrent file writes.

```mermaid
flowchart LR
  fn["TypeScript function with //@ contracts"] --> lsc["LemmaScript"] --> dafny["Dafny"] --> proved{"Proved or not"}
  tla["TLA+ design model"] --> tlc["TLC"]
  qnt["Quint design model"] -- "translated by Apalache" --> tlc
  tlc --> states{"States explored: invariants hold, or a counterexample"}
  proved --> receipt["Receipt"]
  states --> receipt
  code["Code named in covers"] -- "changed: checked again" --> tlc
  code -- "changed without the design model" --> stale["Possibly stale"] --> receipt
```

## An example: two workers and a counter

Two workers each read a count and write it back plus one. With a lock the
count ends at 2; without one, both can read 0 and write 1.
`models/Counter.tla`:

```tla
(* tesota-model
   covers: src/counter.ts increment
   confirmed: 3b7e7bc9
   invariant: NoLostUpdate
   atomic: each read and each write of the stored count
   omits: crashes; more than two workers
   fault: models/CounterNoLock.cfg the lock removed
*)
---- MODULE Counter ----
EXTENDS Naturals
CONSTANT UseLock
VARIABLES count, pc, seen, holder

Workers == {1, 2}
vars == <<count, pc, seen, holder>>

Init == /\ count = 0
        /\ pc = [w \in Workers |-> "read"]
        /\ seen = [w \in Workers |-> 0]
        /\ holder = 0

\* A worker takes the lock, if there is one, and reads the count.
Read(w) == /\ pc[w] = "read"
           /\ UseLock => holder = 0
           /\ holder' = IF UseLock THEN w ELSE holder
           /\ seen' = [seen EXCEPT ![w] = count]
           /\ pc' = [pc EXCEPT ![w] = "write"]
           /\ UNCHANGED count

\* It writes what it read, plus one, and lets the lock go.
Write(w) == /\ pc[w] = "write"
            /\ count' = seen[w] + 1
            /\ holder' = IF UseLock THEN 0 ELSE holder
            /\ pc' = [pc EXCEPT ![w] = "done"]
            /\ UNCHANGED seen

Finished == /\ \A w \in Workers : pc[w] = "done"
            /\ UNCHANGED vars

Next == (\E w \in Workers : Read(w) \/ Write(w)) \/ Finished

\* Once both workers are done, neither increment was lost.
NoLostUpdate == (\A w \in Workers : pc[w] = "done") => count = 2
====
```

`models/Counter.cfg` checks the design with the lock:

```text
CONSTANT UseLock = TRUE
INIT Init
NEXT Next
```

`models/CounterNoLock.cfg`, the planted fault, sets `UseLock = FALSE`.
Tesota checks both:

```text
Model-checked: NoLostUpdate holds in all 9 reachable states; caught 1 of 1 planted fault; not linked to the code.
```

A fault is caught only by a declared invariant or property (in the header
or configuration), or a failed `Assert`. A deadlock alone doesn't count.
Tesota retries it with deadlock checking off (`-deadlock`), with the same
limits: a violation catches it; exhaustive success means too weak; an
unfinished or errored retry means not checked. The receipt names the fault
and both results. A main-configuration deadlock still fails.

## The header

A comment starting with `tesota-model`: in TLA+ before the `MODULE` line,
in Quint in a `/* … */` or `//` comment.

| Key | |
| --- | --- |
| `covers` | A file the model describes, from the project root, and its functions; one per file, including injected dependencies such as a lock |
| `confirmed` | Optional: the commit at which someone last confirmed the model describes the code |
| `invariant` | The definitions TLC checks, separated by commas |
| `atomic` | What the model treats as one indivisible step |
| `omits` | What the model leaves out |
| `fault` | A variant that must break a declared property or assertion: another `.cfg`, a `.tla` with its own `.cfg`, or a `.qnt` |
| `replay` | Optional: a command that replays the model's traces against the code |

A TLA+ model uses the `.cfg` beside it, plus the header's invariants. A
path outside the project isn't read.

## When it runs

When a request changes a model or a file it covers, Tesota checks it once
before the run ends: the model, then its faults, then `replay`, each with
five minutes, and TLC with 2 GB of memory. The agent gets a `check_model`
tool while it works. A counterexample goes back as numbered steps; a fault
that passes goes back as too weak; a model written without a header goes
back once with the format. Without Java or TLC the receipt says it wasn't
checked ([Installation](../reference/installation.md#tools)).

Quint typechecks first, then needs Apalache to translate for TLC, which
Windows can't start; write models there in TLA+.

## What the receipt says

| Receipt | Meaning |
| --- | --- |
| Model-checked | The invariants hold in every reachable state; caught faults broke a declared property or assertion |
| Model-checked, written with the code | The same, but the model changed with the code, so it may mirror it: weaker evidence, not stale |
| Model fails | A declared property or assertion breaks, or the main run deadlocks; the steps follow |
| Model too weak | A planted fault passes or is broken; unfinished retries leave a gap |
| Model not checkable | TLC couldn't read it |
| Model not checked | Java, TLC or Quint is missing, it ran out of time, or it has no header |
| Model possibly stale | Covered code changed since `confirmed`, without the model |
| Model staleness unknown | No `confirmed`, or a commit the repository doesn't have |

The result is about the model, for what it treats as atomic and the
invariants it names. Without a passing `replay`, it's "not linked to the
code".

## See what TLC explored

Each TLA+ check captures the model graph: the states TLC reached and the
steps between them. `/graph` opens the newest one full-screen; `!` marks a
state that breaks an invariant.

It opens on the **chart**: a few states labeled in your words by
`<Model>.chart.ts`, which the agent writes, with TLC's trace numbered and
the breaking state in red. Labels are a reading, not evidence. The file
is the project's code: `/graph` asks you to trust it first, as
[hooks](hooks.md#trusting-a-projects-hooks) do, and until you do the chart
is grouped by the control variable. `c` shows
TLC's graph, `t` its trace, and `o` an HTML page in your browser; every
key and the chart's format are in
[Commands and keys](../reference/commands.md#model-graph-viewer).

`/graph --plain`, the inline shell and terminals under 40×12 print the
graph as text. Over SSH, `tesota graph --html <capture>.manifest.json`
writes the page to copy elsewhere. The files sit beside the session, not
in the project, and never change the receipt. A graph is **partial** when
TLC stopped early (counts are lower bounds), and **unavailable** past
16 MiB of output, 10,000 states or 50,000 edges, or on an error other than
a broken invariant. Quint captures no graph.

## Related

[Verification](verification.md) · [Receipts](receipts.md) ·
[Checks](../reference/checks.md#design-models)
