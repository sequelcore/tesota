# Verification

You don't start verification: when the agent says it's done, Tesota checks
the change, sends failures back, and ends with a receipt. This page is how
to give it more to check.

## What gets checked

| Check | When |
| --- | --- |
| Proofs | A changed TypeScript file has LemmaScript `//@` contracts |
| Tests | The project has check or test commands |
| Test exercise | A test was added or changed: does it fail without the change? |
| Contract strength | A contract was added or changed: do small changes to the code break its proof? |
| Design models | A TLA+ or Quint model changed, or the code it covers |
| Weakened evidence | Always: loosened contracts, deleted or skipped tests, changed check scripts |
| Coverage | Always: changed lines nothing covers |

A model also compares each new contract with your request and lists the
cases your request leaves open. Both are labeled as its opinion, never as
evidence.

## Prove it: contracts

Write LemmaScript annotations above a TypeScript function:

```ts
//@ requires lo <= hi
//@ ensures \result >= lo && \result <= hi
export function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}
```

Tesota proves it with Dafny whenever the file changes, and the agent gets
a `prove` tool to work until it passes. Write exactly one space after
`//@` and after the keyword; Tesota points out lines LemmaScript would
skip.

A contract that still proves after a comparison flips or a constant moves
by one is too weak, and goes back. A proof that leans on `//@ assume`,
`//@ extern` or `//@ skip` holds only if what it trusts is right, and the
receipt says so. Midspiral's [LemmaScript skills](https://github.com/midspiral/lemmascript-skills)
teach an agent the grammar; put them in `~/.agents/skills`.

## Model-check it

A proof can't see two calls interleaving; a design model can. See
[Model checking](model-checking.md).

## Test it: your commands

Tesota finds each project at the repository's root and up to three folders
below, and runs:

| Project | Commands |
| --- | --- |
| JavaScript or TypeScript | `check`, or else `typecheck`, `lint` and `test`, with the package manager `packageManager` or the lockfile names |
| Gradle | `check`, through `./gradlew` when present |
| Maven | `verify`, through `./mvnw` when present |
| Cargo | `cargo test` |
| Go | `go test ./...` |

A changed file belongs to the nearest project that has commands, and
workspace members keep their own. Each command has 15 minutes; on Windows
they run in Git's bash. A changed test file runs alone through its
package's `test` script when that's plain Bun, Vitest or Jest; otherwise
the project's checks run, and the receipt names which.

### Sharper evidence: test reports

When your tests write a JUnit XML report under the project, Tesota knows
which tests failed, so it can credit a new test even when others already
fail. Gradle and Maven write one already. Elsewhere:

- **Bun:** `bun test --reporter=junit --reporter-outfile=./junit.xml`
- **Node:** `node --test --test-reporter=junit --test-reporter-destination=junit.xml`
- **Vitest:** the `junit` reporter with an `outputFile`

## Choose the opinion models

Both opinions use the session's model unless you name another:

| Flag | Setting | Role |
| --- | --- | --- |
| `--claimcheck-model <provider>/<id>` | `claimcheckModel` | Restates each new contract without seeing your request |
| `--open-cases-model <provider>/<id>` | `openCasesModel` | Lists the cases your request leaves open; `off` turns it off |

A flag wins over the [setting](../reference/configuration.md#settingsjson)
for one run. If a model can't answer, the receipt says why and the run
still ends. An opinion never goes back to the agent.

## Outside one repository

- **A folder of repositories:** each changed repository is verified on its
  own, in one receipt.
- **A folder in no repository:** Tesota compares against its own snapshot
  in `~/.tesota/snapshots`, without your `.env` files. A home folder, a
  drive's root or a folder of more than 20,000 files isn't snapshotted, so
  changes there aren't verified.

## Related

[Model checking](model-checking.md) · [Receipts](receipts.md) ·
[How verification works](../concepts/verification.md)
