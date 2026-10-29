# Development

How to build, test and prove Tesota, and where things go. How it works is
in [Architecture](concepts/architecture.md) and
[How verification works](concepts/verification.md).

## Set up

Use the Bun version in `packageManager` and the Node version in
`devEngines` of [package.json](../package.json); CI reads both. Dafny is in
[mise.toml](../mise.toml) for `mise install`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run vendor
```

`bun run vendor` downloads the pinned ripgrep archives in
[ripgrep.json](../ripgrep.json), verifies their SHA-256 and executables,
and keeps each target's `rg` in the ignored `vendor/ripgrep/<target>/`;
`--force` fetches them again. `bun link` in `packages/core` puts your
checkout's `tesota` on the `PATH`.

## Checks

| Command | |
| --- | --- |
| `bun run check` | Every check: types, the verification layer's tests, lint, and the engine's check |
| `bun run formal:check` | Prove every LemmaScript rule in `src/verification/` and `packages/core/src/`; needs Dafny |
| `bun run typecheck` | Types of `src`, `tests` and `evaluation` |
| `bun run test` | The verification layer's tests, with Vitest |
| `bun run lint` | Oxlint, rejecting warnings, without fixes |
| `bun run --cwd packages/core check` | The engine's types, its tests, and its performance budgets |
| `bun run --cwd packages/core budget --report` | Measure the budgets without failing, to set or revise a limit |
| `bun run --cwd packages/core screenshots` | Draw the documentation's images again |

Before finishing a change, run `bun run check`, `bun run formal:check` when
a proved rule changed, and `git diff --check`. CI runs the root and engine
checks in parallel on Ubuntu, Windows and macOS, the engine tests in two
shards, the whole `formal:check` once on Ubuntu, and the engine's session
and tool tests on musl Linux; `CI gate` passes only when all of them do.
`bun run check` never calls a live model. Report what ran: a passing
check, a live observation and a person's acceptance are different claims.

## Layout

| Folder | |
| --- | --- |
| `packages/core/src` | The engine: `main.ts` is the `tesota` command; `loop.ts`, `session*.ts`, `permissions.ts`, `workspace.ts`, `hooks.ts`, `mcp*.ts`, `instructions.ts`, `print.ts`, and `shell/` |
| `packages/core/tests` | The engine's tests, with an emulated terminal (`@xterm/headless`) for the shell |
| `src` | The verification layer, written against `src/contract.ts`; the engine gives it its parts through `src/host.ts` |
| `src/verification` | Verification's proved rules and LemmaScript runner |
| `tests` | The verification layer's tests, with Vitest, on a test host (`tests/host.ts`) |
| `evaluation` | Measurements of Tesota's defaults on live models (`engine-session.ts`) |
| `themes`, `terminal-schemes`, `grammars` | The themes, the terminal color schemes, and the tree-sitter grammars coverage reads |

`lemmascript` and `web-tree-sitter` are runtime dependencies. The grammars
are pinned development dependencies kept as `.wasm` in `grammars/`; a test
fails when one differs from its package.

## Tests

- **Behavior, not wording:** what happened to files and which calls failed,
  not how a message reads.
- **Isolated homes:** run engine tests with `bun run --cwd packages/core test`.
  A direct `bun test` refuses to start outside the wrapper, which gives
  each run its own home, removes Claude and Anthropic credentials from the
  environment, and puts a signed-out Claude fake on the `PATH`.
- **Real processes:** session tests kill a process mid-run and mid-settle
  to check recovery.
- **The shell** is drawn in an emulated terminal; flicker on a real Windows
  console still needs a person to look.
- **Guards:** a test fails on a Pi package other than `pi-ai`, `pi-tui` or
  `pi-mcp`; lint limits cyclomatic complexity to 20.

## Proved rules

A pure decision that can be stated precisely, such as a permission, a
budget or a test's origin, carries LemmaScript `//@` specifications from
its requirement, in a `*-rule.ts` file named in `formal:check`. A
deliberately wrong version must fail the proof.
[Proved rules](reference/proved-rules.md) lists them. After changing a
specified function:

```sh
./node_modules/.bin/lsc regen --backend=dafny src/verification/gate-rule.ts
./node_modules/.bin/lsc check --backend=dafny src/verification/gate-rule.ts
```

`regen` keeps hand-written proof additions and refuses a `.dfy` whose
generated lines were edited. Running `check` first rewrites the `.dfy.gen`
`regen` compares against: restore it with Git and run `regen` again. Never
delete a `.dfy`; that discards its proof additions.

## Performance budgets

The budget check compiles the engine as a release would and fails a pull
request when a measurement exceeds its limit in
[budgets.json](../packages/core/budgets.json) in both of two attempts:
startup, binary size, the scripted loop's time and memory, the base, syncs
to disk, settlement, resuming a 1,000-entry session and its size, the
shell's first frame, and its memory with pi-ai's whole provider catalog
loaded. On Windows the first frame is limited relative to the same
attempt's startup, and on Linux to its resume, with a looser limit in
milliseconds behind both. New limits come from measurements and need the
owner's approval.

## Binaries

[build.ts](../packages/core/scripts/build.ts) is the one build;
`bun packages/core/scripts/build.ts <folder>` builds every target. A binary
embeds LemmaScript, the TypeScript parser, tree-sitter and its target's
ripgrep, extracted once under `~/.tesota/ripgrep/<version>-<sha256>/`, so
it verifies and searches without a checkout or download; it runs
LemmaScript as its own `__lsc` command. The binaries workflow builds,
starts and installs every target on each pull request, and
`binary.test.ts` proves and searches from a binary outside the checkout.

## Releases

A release is a GitHub Release of the binaries, published by the binaries
workflow from a tag, never from a machine. Until the first stable release,
versions are `0.1.0-alpha.<n>` prereleases. A fix that stops sessions,
loses work, makes the receipt claim more than it observed, or crosses a
permission or security boundary ships on its own.

1. Set `<version>` in [package.json](../package.json) and
   [packages/core/package.json](../packages/core/package.json), date its
   section in [CHANGELOG.md](../CHANGELOG.md), and merge to `dev`.
2. Tag that commit `v<version>` and push the tag.
3. The workflow refuses a tag that doesn't match both versions or reuses
   one. It builds and starts every target and runs `ci.yml` on the tag;
   only then does the publish job check the files against `SHA256SUMS`,
   attest each binary and publish them, as a prerelease when the version
   has a suffix.
4. Check it: `gh attestation verify <binary> --repo sequelcore/tesota`, then
   install with the script and run a request through to a receipt.

A published version is never reused.

## Effect

Code that coordinates processes, time limits, cancellation, resources or
concurrency is written with [Effect](https://effect.website) 4, one part
at a time, each measured against the budgets; `src/process.ts` was first.
A resource is acquired with its release, so a stop is an interruption, not
a flag. Until its callers move, a part keeps its `Promise` signature.

- **Import modules by path** (`effect/Effect`), never the root `effect`:
  about 35 MB from source against 16 MB. `inventory.test.ts` enforces it,
  and code on the shell's path loads checks when first used.
- **Stable core modules only:** every submodule, and core modules such as
  `FileSystem`, `Path` and `Terminal`, is unstable in 4.0, and
  `inventory.test.ts` refuses them.
- **An interrupted verification step is awaited:** a gate step aborts its
  processes and waits, so no check runs after Tesota reports.
- **A stop interrupts the model's turns** (`step` in
  `packages/core/src/loop.ts`): every call still ends with a result, and
  settlement is only signaled, so the verifier can finalize the stopped run.
- **Proved rules stay plain functions,** called from Effect code.
- **Write Effect 4, not 3:** check a name in the installed package first
  (`Effect.async` is now `Effect.callback`). Effect's `ai` and `cli` aren't
  used.

## Adding a capability

Add a capability for a real consumer, and measure one that claims to
improve results against the simplest alternative before it becomes a
default. Keep one owner per behavior. Nothing outside the repository uses
Tesota's internal contracts, so obsolete code and docs are removed, never
aliased. A change to a verification rule, an evidence format or what
counts as accepted needs its reason and checks at that boundary, and must
never look successful by removing what detected a failure.

## Adding a verifier

A verifier is a dependency, whether a third party or Sequel maintains it.
Sequel's own lives in a separate package that works without Tesota, and
improving an existing project upstream comes before a fork. The owner
approves adopting one, which needs:

- **Declared support.** It states which language and checks it supports
  and rejects anything else as unsupported, never as a pass.
- **A reference in its CI.** Each release is compared with a pinned
  reference tool and with cases whose outcomes were written first,
  planted faults included. Verdicts, traces and completed explorations
  are compared, not exit codes alone; an unresolved disagreement blocks
  adoption.
- **Honest failures.** A timeout, cancellation, exhausted limit or crash
  never counts as a pass.
- **A named backend.** The receipt says which verifier and version ran.

## Branches

`main` is stable and `dev` the protected integration branch. Work starts on
a short branch from `dev` and returns through a pull request and the merge
queue; `dev` reaches `main` through a pull request with a merge commit. A
hotfix starts from `main` and is merged back into `dev` promptly. Both
branches require `CI gate` and resolved conversations, and forbid force
pushes and deletion.

## Documentation

The docs are for people and agents alike.

- **One page, one subject, one owner.** Update the page that owns a fact
  and link to it; don't restate what `--help`, a config file or the code
  already says.
- **The task first,** then the example, then one line of why. Guides say
  what a feature does, how to start, and what's unintuitive, not every
  state on screen; exact rules go to the reference.
- **Only what the code does today.** No history or plans outside the
  [roadmap](../ROADMAP.md). Check each claim against the code.
- **Plain words, short sentences,** identifiers as code. No credentials,
  personal paths or scratch notes.
- **Within budget.** `tests/docs-budget.test.ts` holds each kind of page to
  a word budget; a page that needs more is split, or its detail moves to
  the page that owns it.

| Content | Page |
| --- | --- |
| What Tesota is, and how to start | [README](../README.md) |
| Installing and a first session | [Get started](get-started/install.md) |
| Using a feature | [Guides](README.md#guides) |
| How it's built, and why | [Concepts](README.md#concepts) |
| Exact commands, keys, files and rules | [Reference](README.md#reference) |
| The receipt's format | [Receipt v2](receipt-v2.md); keep its path, which receipts name |
| Direction and non-goals | [Roadmap](../ROADMAP.md) |
| How the terminal looks, and why | [DESIGN.md](../DESIGN.md) |
| What each release changed | [Changelog](../CHANGELOG.md) |
| Building and testing Tesota | This page |
| Instructions for agents working on Tesota | [AGENTS.md](../AGENTS.md) |

When moving or removing a page, update its links.
