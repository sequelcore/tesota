# Verification

Every run ends in verification. You don't start it: when the agent says
it's done, Tesota checks the change against your request, sends failures
back, and ends with a receipt. This page covers what it checks and how to
give it more to check.

## What gets checked

| Check | When it runs |
| --- | --- |
| Proofs | A changed TypeScript file has LemmaScript `//@` contracts |
| Tests | The project has check or test commands |
| Test exercise | A test was added or changed: does it fail without the change? |
| Contract strength | A contract was added or changed: do small changes to the code break its proof? |
| Design models | The request changed a TLA+ or Quint model, or the code one covers: do its invariants hold in every reachable state, and does each planted fault break one? |
| Weakened evidence | Always: loosened contracts, deleted or skipped tests, changed check scripts |
| Coverage | Always: changed lines no proof or test covers |

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

A proof can't see two calls interleaving; a design model can. When a
request changes a TLA+ or Quint model, or the code its header covers,
Tesota checks it with TLC. [Model checking](model-checking.md) covers how to
write one, what the receipt says about it, and how to explore the states
TLC reached.

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

A changed file is checked by the nearest project with check commands that
holds it. JavaScript workspace members keep their own commands, whether
workspaces are declared in `package.json` (npm or Bun) or
`pnpm-workspace.yaml`. The root still owns files outside the members. Each
command has 15 minutes. On Windows the commands run in Git's bash, since
they're written for a POSIX shell.

Changed test files use the owning package's `test` script through its
package manager, from that package's folder, never a direct `bun test` in
place of `bun run test`. Supported plain Bun, Vitest and Jest scripts can
run one file with reporting. A wrapper or composite script falls back to
the owning project's whole checks. For workspace members, the receipt
names the command and why per-file probing was unavailable, including when
the workspace root is nested inside the checkout.

A workspace member without a `test` script uses the nearest workspace root
above it that has one. The receipt names that fallback. If neither the
member nor a workspace root has a test script, the receipt says the test
was not run; lint alone is not test exercise evidence. This fallback only
changes test exercise: a member-only change still selects the member's
check commands, not the root's aggregate check.

### Sharper evidence: test reports

When your test command writes a JUnit XML report anywhere under the
project, Tesota reads which tests failed, not only whether the command
did. It can then tell that a new test catches your change even when other
tests already fail. When a command fails, Tesota runs it on the commit the
request started from too: a failure whose tests all failed there already
stays from the agent and is recorded as failing before the change. Without
reports, Tesota can't tell, so the failure goes back with that reason. Gradle
and Maven write these reports already. Elsewhere:

- **Bun:** `bun test --reporter=junit --reporter-outfile=./junit.xml`, or
  `[test.reporter] junit = "junit.xml"` in `bunfig.toml`.
- **Node:** `node --test --test-reporter=junit --test-reporter-destination=junit.xml`.
- **Vitest:** its `junit` reporter with an `outputFile`
  ([reporters](https://vitest.dev/guide/reporters)).

## The model's opinions

| Flag | |
| --- | --- |
| `--claimcheck-model <provider>/<id>` | A second model restates each new contract without seeing your request; the session's model compares the two |
| `--open-cases-model <provider>/<id>` | The model that lists the cases your request leaves open; `off` turns the list off |

Both roles use the session's model by default. To choose once for every run,
set `openCasesModel` or `claimcheckModel` in your
[`~/.tesota/settings.json`](../reference/configuration.md#settingsjson),
using a `provider/id`. `openCasesModel` also accepts `off`.
A flag overrides its setting for one run: flag, then setting, then the
session's model. Both flags go to `tesota` or `tesota -p`.

If a role's model is unknown, lacks a sign-in, or otherwise cannot answer,
the receipt says why it was not listed or not judged; the run still completes.
Neither result ever goes back to the agent or counts toward what needs you.

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

- [Model checking](model-checking.md)
- [Receipts](receipts.md)
- [How verification works](../concepts/verification.md), for each rule in
  full
