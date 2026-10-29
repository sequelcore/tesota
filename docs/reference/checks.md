# Checks

Every rule each check follows. [How verification works](../concepts/verification.md)
explains why; [Receipt v2](../receipt-v2.md) specifies what the receipt
records.

## When a run is verified

A run is verified when generation ends after a tool call that may change
files started and a change was observed. Built-in readers and questions
don't count; `prove` does, since it regenerates proof files. A read-only
session never verifies another session's edits in a shared folder. An
unanswered question ends generation; the changes are still checked.

## Change scope

- **In Git:** Tesota captures `HEAD` and the content of dirty paths at the
  first call that may change files, and again at the end. Commits made
  during the request, deletions and untracked files all count.
- **Inherited changes:** files already dirty whose content stayed the same
  stay out of proof and exercise scope; commands still run with them.
- **Attribution:** when the captures and history can't credit a change to
  the request, its files are still checked, but measurements that need a
  reliable start are left out ([Receipt v2](../receipt-v2.md#capturestate)).
- **Gaps:** an unreadable capture or a file too large to hash can't show
  that nothing changed. Weakening checks compare with the starting commit.
- **Outside Git:** a private snapshot in `~/.tesota/snapshots`, without
  `.env` and `.env.*`, ignored files, dependencies or build output. Home
  folders, drive roots and folders past the size or reading limits are
  refused. A folder of repositories is checked one unit per repository.

## Repairs

A failure goes back unless the same one already did, compared by proof
output, failing test names, surviving changes or counterexamples. A
command without test reports gets one repair attempt.

A failing project command runs again in a worktree of the starting commit.
It stays from the agent only when the base fails the same way and both
runs' test reports show each failing test failing there too; the receipt
records it as failing before the change. Without reports, a base that
can't run, or a request that didn't start from it, the failure goes back
with that reason. The engine allows 32 automatic continuations per run.

## Proofs

LemmaScript regenerates each changed source's Dafny proof, keeping
hand-written additions, and Dafny verifies it, five minutes per process. A
clean exit that verifies nothing earns no proof. Proofs sit beside their
sources, or under `proof-dir` in `lemmascript.json`; a changed `.dfy` or
`.dfy.gen` is traced back to its source and confirmed with `lsc config`.

A proof is conditional on `//@ assume`, `//@ extern`, `//@ skip`, selective
`//@ verify` and hand-written Dafny axioms, and is shown with those
qualifications. It holds in LemmaScript's model of TypeScript:

- Numbers are mathematical integers, or exact reals for non-integer
  literals: `0.1 + 0.2 == 0.3` proves. No 53-bit bound, no `NaN`,
  `Infinity` or `-0`; bitwise operations don't wrap at int32.
- Only the supported subset: no true `async`/`await`, class inheritance or
  mutation outside it; no `**`, `>>>`, `Math.round`, `Math.trunc`,
  `Math.sqrt` or `Math.pow`.
- With `//@ verify` in a file, only opted-in functions are checked;
  otherwise every top-level function. Class methods need `//@ verify`.

See the [LemmaScript specification](https://github.com/midspiral/LemmaScript/blob/main/SPEC.md).

## Contract strength

Once the commands pass, Tesota tries up to eight small changes per new or
changed top-level contract: a flipped comparison, another returned value,
another operator. A change that still proves survives. Dafny then checks
whether each survivor returns the same result for every admitted input; an
equivalent one doesn't count. Any other survivor makes the contract weak.

## Tests

| Project | Commands |
| --- | --- |
| JavaScript or TypeScript | `check`, or else `typecheck`, `lint` and `test`; the package manager from `packageManager`, else the lockfile, else the first of npm, Bun, pnpm and Yarn on `PATH` |
| Gradle, Maven | `check` and `verify`, through the wrapper when present |
| Cargo, Go | `cargo test`, `go test ./...` |

Projects are found at the root and up to three folders below; workspace
members from `package.json` or `pnpm-workspace.yaml` keep their own
commands, and the root owns files outside them. Each command has fifteen
minutes; on Windows they run in Git's bash.

Changed test files run against the starting code in a temporary worktree,
through the owning package's `test` script: alone for plain Bun, Vitest
and Jest scripts, otherwise as the project's whole checks. A member
without `test` uses the nearest workspace root with one; with neither, the
test isn't run, and lint alone is no exercise. Reports must show the
selected tests ran; a filter that also picks other files is named.

A test earns exercise evidence only when it fails on the starting code and
passes with the change, and the command passes with the whole change in
the same worktree. A test that passes on the start doesn't depend on the
change. Changed dependency manifests or lockfiles leave the result unknown.

## Design models

TLC explores every reachable state of the configured model; its
constants, constraints or a depth limit set the bounds. The `tesota-model`
header names the covered code, invariants, atomic steps, omissions and
planted faults. A model is checked when its files, faults or covered code
change; a passing check is reused for the same content.

A fault that passes, or can't be read, fails the check; an unfinished one
leaves a gap; a model with no fault earns no passing evidence. A
counterexample comes back as numbered steps for the agent to compare with
the code. The receipt states the omissions, whether the model was written
with the code, and whether covered code differs from its confirmed commit;
a passing `replay` command links the model to the code. A model graph
shows explored states, not an execution trace.

## Weakened evidence

Diff rules flag removed contracts, new preconditions, added assumptions,
excluded proof code, deleted tests and changed check scripts. In
JavaScript and TypeScript (Bun, Vitest, Jest), test edits name removed or
loosened assertions, skips, focused tests and mocks; other languages get a
file-level flag. These are review flags: a legitimate change can trigger
one, and some weakening goes unflagged. A diff too large to read is
reported as unchecked.

## Model opinions

- **ClaimCheck:** one request restates each contract without your request;
  another compares that with your request.
- **Open cases:** reads your saved request, without the change or the
  files and URLs it names, and lists inputs with more than one plausible
  result. Two minutes; `off` turns it off.

Both read, before your request, the earlier unverified requests back to
the last successful settlement, as many whole requests as fit the model's
context, by token estimate; the receipt names any left out.

## Evidence and export

Evidence records the checker, outcome, output, duration and a hash of its
files. A pass whose files changed is dropped before publishing, keeping
the checked hash. Export rechecks proof, command and model evidence
against the commit and refuses if it doesn't hold exactly what the checks
saw. As a Statement, `verified` and `unchanged` state `COMPLETED`, `failed`
states `FAILED` and a stopped run `CANCELLED`; `incomplete` and
`unverified` aren't exported.

## Stops and recovery

A question waits until you answer, dismiss it or stop. Stopping during
verification interrupts the check and its processes; the receipt claims no
evidence and lists changed files from a read-only inventory, thirty
seconds at most. If the process dies, reopening the session records the
run once: a call that may have changed files gets a receipt that verified
nothing; unfinished reads are marked as having no effect, other started
calls as unknown, unstarted ones as not run. Nothing is replayed.
