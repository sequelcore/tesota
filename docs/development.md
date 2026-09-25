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

`bun run check` does not invoke Dafny or a live model. Tests exercise real Git
workspaces, check processes, Oxlint and compiled CLI processes. Use `test:fast`
for quick feedback on pure code, then the affected process-backed suite. Run `bun run check` and
`git diff --check` before completing a change. Report what actually ran;
passing checks, live observations and human acceptance are different claims.

The package binary points to `dist/cli.js`. Build before `bun link`; later builds
refresh that linked executable. Use `bun unlink` to remove it. For the user
workflow, see [Using Tesota](using-tesota.md). Checks, lower-level commands and
their owners are in [architecture](architecture.md); authentication is in
[authentication](authentication.md).

`bun run live:codex` runs the live Codex probe with the saved login and writes
one JSON record per run under the ignored `live-runs/codex/` directory.

## Change scope

Keep one owner per behavior and add modules only for implemented consumers.
Preserve unrelated work and retained attribution. Changes to verification rules,
evidence formats, permissions or acceptance criteria need rationale and checks
at the affected boundary. A change must not appear successful because it
removed the condition that detected a failure.

Use the [Kiln reference](references/kiln.md) for a specific code or test need;
its package structure and roadmap are not defaults for Tesota. The repository
lint rule limits classic cyclomatic complexity to 20 in `src` and `tests` with
no file exceptions. The Git workspace suites run in a separate Vitest process
so a timed-out filesystem operation cannot contaminate later suites.

## Documentation ownership

Write maintained documentation in English using identifiers from code and
plain explanations. Update the existing owner rather than repeating its
contract in another guide.

| Content | Owner |
| --- | --- |
| Orientation | [README](../README.md) |
| Supported user workflow | [Using Tesota](using-tesota.md) |
| Status and priorities | [Roadmap](roadmap.md) |
| Purpose, design, checks and boundaries | [Architecture](architecture.md) |
| Authentication | [Authentication](authentication.md) |
| What experiments established | [Findings](findings.md) |
| Consequential decisions | `docs/decisions/`, linked from the affected guide |
| Historical Kiln reference | [Kiln reference](references/kiln.md) |
| Agent working instructions | [AGENTS.md](../AGENTS.md) |

Record a live observation as a short entry in [findings](findings.md): what
was tried, the outcome and the lesson. Do not add protocols, transcripts or
machine evidence to the repository.

Mark proposed work as proposed and verify current claims against code. Mark
superseded decisions instead of rewriting them. Keep credentials, conversation exports, scratch notes and
session bookkeeping outside tracked documentation. Do not use Kiln's private
state namespace for Tesota.

When moving or removing documentation, update links and affected references.
Check relative links, commands and source claims; do not retain temporary
validation scripts. Milestone codes belong only in historical context.
