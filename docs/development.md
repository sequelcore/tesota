# Development

## Toolchain and checks

Use the Bun version in `packageManager` and the Node version in `devEngines`
of [package.json](../package.json); CI reads both from there. Dafny, which
`bun run formal:check` needs, is declared in [mise.toml](../mise.toml) for
`mise install`. From the repository root, install with
`bun install --frozen-lockfile --ignore-scripts`. Dependencies come from
registry packages; lifecycle scripts are disabled.

| Command | Purpose |
| --- | --- |
| `bun run build` | Empty `dist/` and compile the `tesota` launcher to it; `npm pack` runs it first |
| `bun run typecheck` | Check source and test types |
| `bun run test` | Build and run the tests |
| `bun run lint` | Lint source and tests without fixes; reject warnings |
| `bun run check` | Run the complete repository gate, including the engine's |
| `bun run formal:check` | Prove the LemmaScript rules in `src/verification/` and `packages/core/src/`; requires Dafny |
| `bun run --cwd packages/core check` | Typecheck the engine, run its tests with `bun test`, and check its performance budgets |
| `bun run --cwd packages/core budget --report` | Measure the engine's startup and binary size without failing, to set or revise a limit in `packages/core/budgets.json` |
| `bun run live:eval` | Run the registered cases live through Pi on the operator's sign-in (`evaluation/live.ts`); uses model quota |
| `bun run findings:eval` | Measure review findings turned into reproduction tests on the registered cases (`evaluation/findings.ts`); uses model quota |
| `bun run swesmith:eval` | The same on SWE-smith's JavaScript bugs, with the fix step, operator cases and a reviewer that proposes checks (`evaluation/swesmith.ts`); uses model quota, Claude Code for its review sources, and Docker |

`bun run check` never calls a live model; `bun run live:eval` does, after
`bun run build`, and writes its results to the file `--out` names, outside
the repository, as do the findings evaluations. `bun run swesmith:eval` runs
each repository's tests in its SWE-smith image through the runner image
`docker build -t tesota-swesmith:9b74ac0 evaluation/swesmith` builds, under
4 GB a container; the dataset (`SWE-bench/SWE-smith-js`) is converted to
JSON lines first and named with `--data`. The check's tests that prove files run
only where Dafny is installed. CI installs Dafny from `mise.toml` on Ubuntu
and Windows, so those tests run there, and `bun run formal:check` runs after
the check. The launcher tests run
the compiled launcher and the Pi it finds. Run `bun run check`,
`bun run formal:check` when a proved rule changed, and `git diff --check`
before completing a change. Report what actually ran; passing checks, live
observations and human acceptance are different claims.

The engine, `@tesota/core` in `packages/core`, is being built in slices
([#432](https://github.com/sequelcore/tesota/issues/432)).
`packages/core/src/contract.ts` defines the contract Tesota uses from its
host, and the conformance tests check each engine against it, with Pi as the
reference. A guarantee Tesota needs and Pi lacks is tested as expected to
fail on Pi. The inventory test fails when `src/` starts using a part of Pi
that is not in the contract, an engine export, `pi-ai`, or the shell. The
budget check fails a pull request when the compiled engine's median
`--version` startup or its binary size exceeds the limit for its platform.

Tesota is a Pi package. Pi loads its extension from `src/extension.ts`, which
the `pi` manifest in `package.json` names. The `tesota` command, built to
`dist/cli.js`, finds the Pi installed beside it, or else the one the first
`pi` on PATH runs, checks it against the minimum version in
`peerDependencies`, and runs it with the package loaded. It runs Pi's script
with Node and never a package manager's shim, such as npm's `pi.cmd`, so the
operator's arguments never pass through a shell; a `pi` that is not an
installed Pi package, such as a standalone binary, is not used. It refuses to
start when an extension file the manifest names is missing, since Pi would
skip it without a word and open without Tesota.
Pi is an optional peer dependency, never a runtime dependency, so the package
uses the operator's Pi; the development copy in `devDependencies` must meet
the minimum, which a test checks. `typebox`, which Pi supplies to extensions,
is an optional peer for the same reason. `lemmascript` is a runtime
dependency: `prove` and the gate run its `lsc` with the operator's Dafny in
the project itself, as described under "Adding a capability".
`web-tree-sitter` is a runtime dependency that reads the languages Tesota
has a grammar for. The grammars themselves are development dependencies,
pinned exactly; the package ships only each one's `.wasm`, in `grammars/`,
not the native add-on and install script its package carries, and a test
fails when a shipped file differs from the pinned package's. The `files`
list in `package.json` names what the package ships: the extension's sources
and the compiled launcher, each with what it imports, the grammars, the
themes, the terminal schemes and the notices. A module added to either goes into that
list too; a test packs the package and fails when a packed file imports one
that is not packed, or when anything else is packed. The
[verification design](design/verification.md) describes the gate, its
rungs and the receipt, and [receipt v1](receipt-v1.md) the receipt's format.
The tests that prove files run only where Dafny is installed; the gate's tests script the proofs and the
model instead and run real commands. Build before `bun link`; later builds
refresh that linked executable, and `bun unlink` removes it. The lint rule
limits cyclomatic complexity to 20 in `src` and `tests` with no file
exceptions.

## Adding a capability

A capability is added for a real consumer, and one that claims to improve
results is measured against the simplest alternative before it becomes a
default. Prefer an existing owner, keep one owner per behavior, and add
modules only for implemented consumers. There are no external consumers of
Tesota's internal contracts: obsolete code and documentation are removed, not
kept behind aliases or compatibility paths. Pure decision rules that can be
stated precisely, such as the minimum Pi version, test origins and proof
coverage, carry LemmaScript specifications and are proved by
`bun run formal:check`.

A rule's proof lives in its `.dfy`: the program LemmaScript generates, kept
also as `.dfy.gen`, plus any proof added by hand. When a specified function
changes, run `lsc regen --backend=dafny <file>.ts` before `lsc check`. Regen
generates the program again, keeps the proof additions, refuses a `.dfy`
whose generated lines were edited, and verifies the result. Running `check`
first rewrites the `.dfy.gen` that regen compares against, and regen then
refuses; restore the committed `.dfy.gen` with Git and run regen again. Never
delete a `.dfy` to regenerate it: that discards its proof additions.

Changes to verification rules, evidence formats or acceptance criteria need
rationale and checks at the affected boundary. A change must not appear
successful because it removed the condition that detected a failure.

## Branches

`main` is the stable default branch and `dev` the protected integration
branch. Work starts on a short-lived branch from `dev` and returns through a
pull request; integrated increments move from `dev` to `main` through a pull
request with a merge commit. A hotfix starts from `main` and is merged back
into `dev` promptly. Both branches require the Ubuntu and Windows checks, an
up-to-date pull request and resolved conversations, and forbid force pushes
and deletion.

## Documentation

Write maintained documentation in English, with identifiers from code and
plain explanations. Update the owner below rather than repeating its content
elsewhere. Public wording leads with what the person can do, then why the
evidence matters, then mechanism, and never claims more than was exercised.

| Content | Owner |
| --- | --- |
| Orientation | [README](../README.md) |
| Remote setup and use | [Remote work](remote-work.md) |
| Status and priorities | [Roadmap](roadmap.md) |
| How verification works | [Verification design](design/verification.md) |
| What the engine must avoid, from other harnesses | [Engine study](design/engine-study.md) |
| The receipt's format | [Receipt v1](receipt-v1.md) |
| Consequential decisions | [Decisions](decisions/), one record per decision, named by date |
| Build, test and contribution practice | This page |
| Agent working instructions | [AGENTS.md](../AGENTS.md) |

Put the current rule in the page that owns it and mark proposals explicitly.
The roadmap contains only current status and unfinished priorities. Record
evaluation results with the change that used them; Git retains the earlier
proposals and observations. Do not add protocols, transcripts or machine
evidence to the repository.

Keep credentials, conversation exports, scratch notes and session bookkeeping
outside tracked documentation, and do not use Kiln's private state namespace.
When moving or removing a document, update its links, and verify changed
claims against code.
