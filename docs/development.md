# Development

## Toolchain and checks

Use the Bun and Node versions in [package.json](../package.json). From the
repository root, install with `bun install --frozen-lockfile --ignore-scripts`.
Dependencies come from registry packages; lifecycle scripts are disabled.

| Command | Purpose |
| --- | --- |
| `bun run build` | Compile the CLI to `dist/` |
| `bun run typecheck` | Check source and test types |
| `bun run test:fast` | Run deterministic tests that launch no external process |
| `bun run test` | Build and run all test groups, including process-backed suites |
| `bun run lint` | Lint source and tests without fixes; reject warnings |
| `bun run check` | Run the complete repository gate |
| `bun run formal:check` | Run the optional standalone LemmaScript/Dafny proof; requires Dafny |

`bun run check` does not invoke Dafny, a live model, Docker qualification or an
external review provider. Tests exercise real Oxlint, controlled Pi boundaries
and compiled CLI processes. Use `test:fast` for quick feedback on pure code,
then the affected process-backed suite. Run `bun run check` and
`git diff --check` before completing a change. Report what actually ran;
passing checks, live observations and human acceptance are different claims.

The package binary points to `dist/cli.js`. Build before `bun link`; later builds
refresh that linked executable. Use `bun unlink` to remove it. For the user
workflow, see [Using Tesota](using-tesota.md). Lower-level commands are described
by their owners:

| Work | Reference |
| --- | --- |
| Authentication and local credential state | [Authentication](authentication.md) |
| Read-only discovery and proposals | [Task proposals](proposals.md) |
| Candidate creation, inspection and cleanup | [Candidate checkouts](candidates.md) |
| Approved task, review, outcome and promotion | [Approved tasks](tasks.md) |
| TypeScript, targeted Node, Oxlint, Dafny and Gentle checks | [Verification](verification.md) |
| Explicit Windows isolation comparison | [Isolation experiment](../experiments/isolation/README.md) |
| Live model probes | [Codex experiment guide](../experiments/codex/README.md) |

The current repository TypeScript and targeted Node profiles require the pinned
Docker image already present locally. The TypeScript profile also needs the
target repository's matching Linux/x64 dependency closure. Tesota does not
install or pull it during a task; [Using Tesota](using-tesota.md#prerequisites)
has the preparation command. The Docker requirement belongs to these profiles,
not every Tesota operation.

## Change scope

Keep one owner per behavior and add modules only for implemented consumers.
Preserve unrelated work and retained attribution. Changes to verification rules,
evidence formats, permissions or acceptance criteria need rationale and checks
at the affected boundary. A candidate must not appear successful because it
removed the condition that detected a failure.

Use the [Kiln reference](references/kiln.md) for a specific code or test need;
its package structure and roadmap are not defaults for Tesota. The repository
lint rule limits classic cyclomatic complexity to 20 in `src` and `tests` with
no file exceptions. Process-backed candidate suites run in separate Vitest
processes so a timed-out filesystem operation cannot contaminate later suites.

## Documentation ownership

Write maintained documentation in English using identifiers from code and
plain explanations. Update the existing owner rather than repeating its
contract in another guide.

| Content | Owner |
| --- | --- |
| Orientation | [README](../README.md) |
| Product purpose and vocabulary | [Identity](identity.md) |
| Supported user workflow | [Using Tesota](using-tesota.md) |
| Status and priorities | [Roadmap](roadmap.md) |
| Implementation and authority boundaries | [Architecture](architecture.md) |
| Product qualification criteria | [Qualification](qualification.md) |
| Implemented check contracts | [Verification](verification.md) |
| Verifier selection criteria | [Verifier strategy](verifier-strategy.md) |
| Task, proposal, candidate and authentication contracts | [Tasks](tasks.md), [proposals](proposals.md), [candidates](candidates.md), [authentication](authentication.md) |
| Experiments and dated observations | [Experiments](../experiments/README.md) |
| Consequential decisions | `docs/decisions/`, linked from the affected guide |
| Historical upstream reference and bootstrap evidence | `docs/references/` and [project history](history/README.md) |
| Agent working instructions | [AGENTS.md](../AGENTS.md) |

Mark proposed work as proposed and verify current claims against code or
retained evidence. Preserve superseded decision rationale and historical machine
evidence bytes. Keep credentials, conversation exports, scratch notes and
session bookkeeping outside tracked documentation. Do not use Kiln's private
state namespace for Tesota.

When moving or removing documentation, update links and affected references.
Check relative links, commands and source claims; do not retain temporary
validation scripts. Milestone codes belong only in historical context.
