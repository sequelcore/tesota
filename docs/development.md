# Development

## Toolchain and checks

Use the Bun and Node versions in [package.json](../package.json). Dafny, which
`bun run formal:check` needs, is declared in [mise.toml](../mise.toml) for
`mise install`. From the repository root, install with
`bun install --frozen-lockfile --ignore-scripts`. Dependencies come from
registry packages; lifecycle scripts are disabled.

| Command | Purpose |
| --- | --- |
| `bun run build` | Compile the `tesota` launcher to `dist/` |
| `bun run typecheck` | Check source and test types |
| `bun run test` | Build and run the tests |
| `bun run lint` | Lint source and tests without fixes; reject warnings |
| `bun run check` | Run the complete repository gate |
| `bun run formal:check` | Prove the LemmaScript rules in `src/verification/`; requires Dafny |

`bun run check` does not invoke Dafny or a live model. The launcher tests run
the compiled launcher and the Pi it finds. Run `bun run check`,
`bun run formal:check` when a proved rule changed, and `git diff --check`
before completing a change. Report what actually ran; passing checks, live
observations and human acceptance are different claims.

Tesota is a Pi package. Pi loads its extension from `src/extension.ts`, which
the `pi` manifest in `package.json` names. The `tesota` command, built to
`dist/cli.js`, finds the Pi installed beside it, checks it against the
minimum version in `peerDependencies`, and runs it with the package loaded.
Pi is an optional peer dependency, never a runtime dependency, so the package
uses the operator's Pi; the development copy in `devDependencies` must meet
the minimum, which a test checks. Build before `bun link`; later builds
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
| Status and priorities | [Roadmap](roadmap.md) |
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
