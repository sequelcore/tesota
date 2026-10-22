# Development

How to build, test and prove Tesota, and where things go. How Tesota works
is in [Architecture](concepts/architecture.md) and
[How verification works](concepts/verification.md).

## Set up

Use the Bun version in `packageManager` and the Node version in `devEngines`
of [package.json](../package.json); CI reads both from there. Dafny, which
proving needs, is in [mise.toml](../mise.toml) for `mise install`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run vendor
```

Dependencies come from the registry, with lifecycle scripts disabled.
Run `bun run vendor` once after installing a source checkout. It downloads
the pinned ripgrep archives in [ripgrep.json](../ripgrep.json), verifies
their SHA-256 and the extracted executables, and puts each build target's
`rg` in the ignored `vendor/ripgrep/<target>/`. Verified executables are
skipped on later runs. Extraction uses Bun's archive API for `.tar.gz` and
Node's zlib for the pinned ZIP executables, without external commands.
`bun run vendor --force` downloads and verifies every archive again.

`bun link` in `packages/core` puts your checkout's `tesota` on the `PATH`.

## Checks

| Command | |
| --- | --- |
| `bun run check` | The whole gate: types, the verification layer's tests, lint, and the engine's check |
| `bun run formal:check` | Prove every LemmaScript rule in `src/verification/` and `packages/core/src/`; needs Dafny |
| `bun run typecheck` | Types of `src`, `tests` and `evaluation` |
| `bun run test` | The verification layer's tests, with Vitest |
| `bun run lint` | Oxlint, rejecting warnings, without fixes |
| `bun run --cwd packages/core check` | The engine's types, its tests, and its performance budgets |
| `bun run --cwd packages/core budget --report` | Measure the budgets without failing, to set or revise a limit |
| `bun run --cwd packages/core screenshots` | Draw the documentation's images again |

Before finishing a change, run `bun run check`, `bun run formal:check` when
a proved rule changed, and `git diff --check`. CI runs both checks on
Ubuntu and Windows. Report what ran: a passing check, a live observation
and a person's acceptance are different claims.

`bun run check` never calls a live model. The tests that prove files run
only where Dafny is installed; the gate's tests script the proofs and the
model, and run real commands.

## Layout

| Folder | |
| --- | --- |
| `packages/core/src` | The engine: `main.ts` is the `tesota` command; `loop.ts`, `session*.ts`, `permissions.ts`, `workspace.ts`, `hooks.ts`, `mcp*.ts`, `instructions.ts`, `print.ts`, and `shell/` |
| `packages/core/tests` | The engine's tests, run with `bun run test` (`bun test` with a home and temporary folder of their own, removed after); an emulated terminal (`@xterm/headless`) for the shell |
| `src` | The verification layer, written against `src/contract.ts`; the engine gives it its parts through `src/host.ts` |
| `src/verification` | Verification's proved rules and LemmaScript runner |
| `tests` | The verification layer's tests, with Vitest, on a test host (`tests/host.ts`) |
| `evaluation` | Measurements of Tesota's defaults on live models, run on the engine from your Tesota sign-in, and Claude through `claude -p` on your Claude sign-in (`engine-session.ts`, [#464](https://github.com/sequelcore/tesota/issues/464)) |
| `themes`, `terminal-schemes`, `grammars` | The two themes, the terminal color schemes, and the tree-sitter grammars coverage reads |

`lemmascript` and `web-tree-sitter` are runtime dependencies. The grammars
are development dependencies, pinned exactly, kept as each one's `.wasm` in
`grammars/`; a test fails when a kept file differs from the pinned
package's.

## Tests

- **Behavior, not wording.** The loop and tool tests check what happened to
  files and which calls failed, not how a message is worded.
- **Real processes.** Session tests kill a process mid-run, and mid-settle,
  to check recovery: that shows what survives a killed process, not a
  power cut.
- **The shell** is drawn into an emulated terminal. Flicker and stale
  fragments on a real Windows console still need a person to look.
- **Imports:** a test fails when Tesota imports a Pi package other than
  `pi-ai`, `pi-tui` or `pi-mcp`.
- **Complexity:** the lint rule limits cyclomatic complexity to 20, with no
  file exceptions.

## Proved rules

A pure decision that can be stated precisely, such as a permission, a budget
or a test's origin, carries LemmaScript `//@` specifications taken from its
requirement, in a `*-rule.ts` file named in `formal:check`. Check that the
proof means something: a deliberately wrong version must fail it.

A rule's proof lives in its `.dfy`: the program LemmaScript generates, kept
also as `.dfy.gen`, plus any proof added by hand. After changing a
specified function:

```sh
./node_modules/.bin/lsc regen --backend=dafny src/verification/gate-rule.ts
./node_modules/.bin/lsc check --backend=dafny src/verification/gate-rule.ts
```

`regen` generates the program again, keeps the proof additions, refuses a
`.dfy` whose generated lines were edited, and verifies the result. Running
`check` first rewrites the `.dfy.gen` that `regen` compares against, and
`regen` then refuses: restore the committed `.dfy.gen` with Git and run it
again. Never delete a `.dfy` to regenerate it; that discards its proof
additions.

## Performance budgets

The budget check compiles the engine as a release would, with code
splitting so the loop loads only when used, and fails a pull request when a
measurement exceeds its platform's limit in both of two attempts in
[budgets.json](../packages/core/budgets.json): `--version` startup, binary
size, the scripted loop's time and memory, the request's base, the number
of syncs to disk, settlement, resuming a session of about 1,000 entries,
that session's size, the shell's first frame, and its memory. On Windows the
first frame is limited divided by the same attempt's median startup, since
runners there differ in speed for the whole job, with a looser limit in
milliseconds for a regression that slows both (#556). A second attempt
measures everything again only when the first exceeds a budget. A sync's time
depends on the disk, so it's only reported; their number has the limit.
New or changed limits are proposed from measurements, and need the owner's
approval.

## Binaries

[build.ts](../packages/core/scripts/build.ts) is the one build: the budget
measures its binary, and `bun packages/core/scripts/build.ts <folder>`
builds every release target into a folder. A binary embeds LemmaScript and
the TypeScript parser as code, and tree-sitter's runtime and grammars as
files, and that target's pinned ripgrep executable, so it verifies and
searches without the checkout. Ripgrep is extracted once under
`~/.tesota/ripgrep/<version>-<sha256>/`, verified before an atomic rename;
there is no runtime download or PATH lookup. Inside a binary, the verifier runs
LemmaScript as the binary's own `__lsc` command. The binaries workflow
builds every target on each pull request and starts each one a runner can
run; `binary.test.ts` proves and reads source from a binary run outside the
checkout, including a search with the embedded ripgrep.

## Effect

Code that coordinates processes, time limits, cancellation, resources or
concurrency is written with [Effect](https://effect.website) 4, moved over
one part at a time, each measured against the budgets; `src/process.ts` is
the first. A resource is acquired with its release (`acquireUseRelease`), so
a stop and a time limit are interruptions rather than flags to check. Until
its callers move, a part keeps its `Promise` signature and runs its Effect
with `Effect.runPromise(effect, { signal })`.

- **Import a module by its path** (`effect/Effect`), never the root
  `effect`, which evaluates the whole package: run from source, the root
  costs about 35 MB, the modules Tesota uses about 16 MB.
  `inventory.test.ts` fails on an import of the root. The shell loads those
  modules through `src/process.ts`; code on the shell's path that would load
  more, as the gate's checks would, loads it when first used (`loadChecks`
  in `src/gate.ts`).
- **A verification step that is interrupted is awaited.** `Effect.promise`
  abandons its promise when interrupted. A gate step that started processes
  aborts them and waits, as the gate's `step` does, so no check runs after
  Tesota reports.
- **The operator's stop interrupts the model's turns, as Codex's does**
  (`step` in `packages/core/src/loop.ts`). Each step a turn waits on (a
  reply, a call, a summary) is told by the run's signal and gets a short
  grace to report on its own; past that the run records it as stopped and
  goes on. Every call still ends with a result: what it reported in time,
  `Stopped: … s into this call`, or `Not run` for the calls after it. A
  promise can't be ended, so work that ignores the signal settles
  unobserved; the processes a tool starts are stopped by `process.ts`.
  Settlement is not interrupted: the stop only signals it, so the verifier
  can finalize the stopped run.
- **Stable core modules only.** Effect tags each module's stability, and an
  `unstable` one may break in a minor release, an `experimental` one in a
  patch release. Every
  submodule (`effect/process`, `effect/ai`, `effect/cli`, `effect/http`, …)
  is unstable in 4.0, and so are some core modules, such as `FileSystem`,
  `Path` and `Terminal`. `inventory.test.ts` fails on an import of either.
- **Proved rules stay plain functions.** LemmaScript proves TypeScript
  functions, not Effect programs, so a decision with a `//@` contract is
  called from Effect code, never written in it.
- **Write Effect 4, not 3.** Models know Effect 3 better, and the API
  changed, for example `Effect.async` is `Effect.callback`; check a name in
  the installed `effect` package before using it.
- Model access stays in `pi-ai` and the terminal in `pi-tui`; Effect's own
  `ai` and `cli` modules are not used.

## Adding a capability

A capability is added for a real consumer, and one that claims to improve
results is measured against the simplest alternative before it becomes a
default. Prefer an existing owner, keep one owner per behavior, and add
modules only for implemented consumers. Nothing outside the repository
uses Tesota's internal contracts: obsolete code and docs are removed, never
kept behind aliases.

A change to a verification rule, an evidence format or what counts as
accepted needs its reason and checks at that boundary. A change must never
look successful because it removed the condition that detected a failure.

## Branches

`main` is the stable branch and `dev` the protected integration branch.
Work starts on a short branch from `dev` and returns through a pull
request; `dev` reaches `main` through a pull request with a merge commit. A
hotfix starts from `main` and is merged back into `dev` promptly. Both
branches require the Ubuntu and Windows checks, an up-to-date pull request
and resolved conversations, and forbid force pushes and deletion.

## Documentation

The docs are for people and agents alike.

- **One page, one subject, one owner.** Update the page that owns a fact;
  link to it from elsewhere.
- **What you can do first,** then why, then how it works. An example
  before the explanation.
- **Only what the code does today.** No history, no "previously", no plans
  outside the [roadmap](../ROADMAP.md); Git keeps the history. Check each
  claim against the code, and never claim more than was exercised.
- **Plain words, short sentences,** identifiers as code. No credentials,
  personal paths, transcripts or scratch notes.

| Content | Page |
| --- | --- |
| What Tesota is, and how to start | [README](../README.md) |
| Installing and a first session | [Get started](get-started/install.md) |
| Using a feature | [Guides](README.md#guides) |
| How it's built, and why | [Concepts](README.md#concepts) |
| Exact commands, keys and files | [Reference](README.md#reference) |
| The receipt's format | [Receipt v2](receipt-v2.md); keep its path, which receipts name |
| Direction and non-goals | [Roadmap](../ROADMAP.md) |
| Building and testing Tesota | This page |
| Instructions for agents working on Tesota | [AGENTS.md](../AGENTS.md) |

When moving or removing a page, update its links.
