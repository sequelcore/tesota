# Verification

Every run ends in verification. You don't start it: when the agent says
it's done, Tesota checks the change against your request, sends failures
back, and settles with a receipt. This page covers what it checks and how
to give it more to check.

## What gets checked

| Check | When it runs |
| --- | --- |
| **Proofs** | A changed TypeScript file has LemmaScript `//@` contracts |
| **Tests** | The project has check or test commands |
| **Test exercise** | A test was added or changed: does it fail without the change? |
| **Contract strength** | A contract was added or changed: do small changes to the code break its proof? |
| **Models** | The request changed a TLA+ or Quint model, or the code one covers: do its invariants hold in every reachable state, and does each planted fault break one? |
| **Weakened evidence** | Always: loosened contracts, deleted or skipped tests, changed check scripts |
| **Coverage** | Always: changed lines no proof or test covers |

Two more come from a model and are labeled as its opinion, never as
evidence: a comparison of each new contract with your request, and the
cases your request leaves open, such as what a function returns for an
empty list.

## Prove it: contracts

Write a contract with LemmaScript annotations above a TypeScript function:

```ts
//@ requires lo <= hi
//@ ensures \result >= lo && \result <= hi
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
```

Tesota proves it with Dafny whenever the file changes. The agent also gets
a `prove` tool once the project has a contract, or as soon as it writes the
first one, and works until the proof passes. Write exactly one space after
`//@` and after the keyword: LemmaScript skips `//@   ensures x` and
`//@ensures x` without a word, and Tesota points those lines out.

A contract that still proves when the function's body is changed (a
comparison flipped, a constant moved by one) is too weak to trust; Tesota
sends it back to be strengthened. A proof that leans on an `//@ assume`, an
`//@ extern` or an `//@ skip` holds only if what it trusts is right, and
the receipt says so.

Midspiral's [LemmaScript skills](https://github.com/midspiral/lemmascript-skills)
teach an agent LemmaScript's grammar and workflow; put them in
`~/.agents/skills` to load them
([Instructions and skills](instructions-and-skills.md)). Their `lemmascript`
skill asks for a `//@ backend dafny` line and a `.verify.ts` name; Tesota
needs neither.

## Model-check it: TLA+ and Quint

A proof covers one function for every input; it can't see two calls
interleaving. A model of the design can: TLC explores every order of its
steps. Tesota checks a TLA+ or Quint model with TLC when a request changes
the model or a file it covers, once before the run settles, unless the
session already checked that exact content. Where Tesota finds TLC, the
agent also gets a `check_model` tool, told that TLC is installed and how
a model declares itself, and works until its model passes.

A model declares itself in a comment at its top. In TLA+, before the
`MODULE` line:

```tla
(* tesota-model
   covers: src/snapshot.ts takeSnapshot prune
   covers: packages/core/src/session-lock.ts
   confirmed: 3b7e7bc9
   invariant: OneWriter, BaseHoldsStaged
   atomic: each Git command's visible effect is one step
   omits: Git's own initialization internals; crashes
   fault: models/SnapshotNoLock.cfg the store lock removed
*)
---- MODULE Snapshot ----
```

| Key | |
| --- | --- |
| `covers` | A file the model describes, from the project root, and the functions in it. Repeat for each file, including injected dependencies such as a lock |
| `confirmed` | The commit at which someone last confirmed the model describes the code. Move it forward only after confirming that again |
| `invariant` | The names of the definitions TLC checks as invariants, separated by commas; or one per line |
| `atomic` | What the model treats as one indivisible step |
| `omits` | What the model leaves out |
| `fault` | A variant that must break an invariant, and what it plants: another `.cfg` of the same specification, a `.tla` with its own `.cfg`, or a `.qnt` |
| `replay` | Optional: a command that replays the model's traces against the code |

Quint takes the same keys in a `/* … */` or `//` comment. A TLA+ model
uses its `.cfg` beside it; Tesota adds the header's invariants to it. Every
key but `confirmed` and `replay` is required, and a path that leaves the
project goes back unread.

What the receipt says:

- **Model-checked**, with the invariants, the reachable states, the planted
  faults caught, and the abstraction. It's about the model, never a proof
  of the code: it reads "not linked to the code" unless a `replay` passes.
- **Written with the code** when the request changed both the model and
  the code it covers: a model that mirrors the code passes for the same
  reason the code does, so it counts as weaker.
- **Possibly stale** when a covered file differs from the `confirmed`
  commit, which a request that changes the code always makes it.

A counterexample goes back to the agent as numbered steps in the model's
names; a model whose planted fault passes goes back as too weak. A TLA+ or
Quint file the request wrote without a header goes back once, with the
format. Without Java or TLC the receipt says the model wasn't checked;
the run never fails for it. [Install](../get-started/install.md) says where
Tesota finds TLC.

pstack's `/create-formal-verification-skill` writes a TLA+ model by
default and records the files it covers and the commit it was confirmed
at; with this header, Tesota checks it on every request that touches them.

## Test it: your commands

Tesota finds each project in the repository, at its root and up to three
folders below, and runs the commands it checks itself with:

| Project | Commands |
| --- | --- |
| JavaScript or TypeScript | The `check` script, or else `typecheck`, `lint` and `test`, with the package manager `package.json`'s `packageManager` field names, else the lockfile's, else the first of npm, Bun, pnpm and Yarn on the `PATH` |
| Gradle | `check`, through `./gradlew` when present |
| Maven | `verify`, through `./mvnw` when present |
| Cargo | `cargo test` |
| Go | `go test ./...` |

A changed file is checked by the project that holds it. Each command has
15 minutes. On Windows the commands run in Git's bash, since they're
written for a POSIX shell.

### Sharper evidence: test reports

When your test command writes a JUnit XML report anywhere under the
project, Tesota reads which tests failed, not only whether the command
did. It can then tell that a new test catches your change even when other
tests already fail, and sends back only the failures that matter. Gradle
and Maven write these reports already. Elsewhere:

- **Bun:** `bun test --reporter=junit --reporter-outfile=./junit.xml`, or
  `[test.reporter] junit = "junit.xml"` in `bunfig.toml`.
- **Node:** `node --test --test-reporter=junit --test-reporter-destination=junit.xml`.
- **Vitest:** its `junit` reporter with an `outputFile`
  ([reporters](https://vitest.dev/guide/reporters)).

## The model's opinions

| Flag | |
| --- | --- |
| `--claimcheck-model <provider>/<id>` | A second model restates each new contract without seeing your request; the session's model compares the two. Without the flag, the session's model does both |
| `--open-cases-model <provider>/<id>` | The model that lists the cases your request leaves open. GPT-6 Sol by default; `off` turns the list off |

Both flags go to `tesota` or `tesota -p`. Neither result ever goes back to
the agent or counts toward what needs you.

## Outside one repository

- **A folder of repositories:** each repository the request changed is
  verified from its own commit with its own commands, and one receipt holds
  them all. In your home folder or a drive's root, only the repositories
  are verified; the other folders there are never snapshotted.
- **A folder in no repository:** Tesota compares against a snapshot it
  keeps in `~/.tesota/snapshots`, never in your folder, and without your
  `.env` files. It doesn't snapshot a home folder, a drive's root, or a
  folder of more than 20,000 files; there, changes are reported as not
  verified.

## Related

- [Receipts](receipts.md)
- [How verification works](../concepts/verification.md), for each rule in
  full
