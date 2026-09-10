# Development

## Toolchain and checks

Use the Bun and Node versions selected in [package.json](../package.json).
Install with `bun install --frozen-lockfile --ignore-scripts`; dependencies come
from registry packages, with no Kiln links. Lifecycle scripts remain disabled.
Run commands from the repository root.

| Command | Purpose |
| --- | --- |
| `bun run build` | Compile source to `dist/` |
| `bun run typecheck` | Check source and test types |
| `bun run test` | Build, then run the test suite |
| `bun run lint` | Check source and tests; no fixes, warnings rejected |
| `bun run check` | Run the complete repository gate |

The main CLI accepts no arguments, `help`, `--help` or `-h` for help (exit 0).
`verify <file.ts|file.js>` runs the [bounded check](verification.md); unsupported
arguments print a diagnostic on stderr and exit 2.

Tests exercise real Oxlint, controlled Pi boundaries and compiled CLI processes.
Normal checks do not log in or invoke a live model. Network experiments have a
separate [operating guide](../experiments/codex/README.md). The CI workflow declares Windows and
Linux checks; a declared lane does not establish that it has run successfully.

Before completing a change, run the relevant checks and `git diff --check`.
Report what actually ran and any unverified behavior. Passing checks, reviewer
judgment, live observations and human acceptance are separate claims.

## Change scope

Keep one owner for each behavior and introduce modules only for implemented
consumers. Preserve unrelated work and retained attribution. Use Kiln through
the [reference procedure](references/kiln.md), selecting code or tests for a
specific need. Do not import its package structure or roadmap by default.

Changes to verification rules, evidence formats, permissions or acceptance
criteria need explicit rationale and checks of the affected boundary. A candidate
must not appear successful because it removed the condition that detected a failure.

## Documentation ownership

Write maintained documentation in English, using the identifiers in code and
plain explanations of their meaning. Link to the existing owner instead of
copying its explanation into another file.

| Content | Owner |
| --- | --- |
| Orientation and navigation | [README](../README.md) |
| Product identity, name and purpose | [Identity](identity.md) |
| Implemented structure and boundaries | [Architecture](architecture.md) |
| Product direction and milestone status | [Roadmap](roadmap.md) |
| Stable behavioral contracts and usage | [Verification](verification.md) |
| Experimental guides and records | [experiments/](../experiments/README.md), grouped by capability |
| Consequential decisions and rationale | `docs/decisions/`, linked from the relevant guide |
| Selected upstream source and reuse | `docs/references/` |
| Bootstrap and toolchain records | [Project history](history/README.md) |
| Agent working instructions | [AGENTS.md](../AGENTS.md); CLAUDE.md references it |

Name product surfaces Tesota and files by their purpose. Milestone codes belong
only in historical context, not package names, CI labels, commands or new schemas.
Mark proposed work as proposed. Update status from repository evidence and
identify conclusions reconstructed from operator reports. Preserve superseded
decision rationale rather than rewriting it as though the later choice came first.
Retain a new report only when it has a durable reader or evidentiary purpose.

Keep conversation exports, scratch notes, personal account information and
session bookkeeping outside tracked documentation. A private repository or
ignored folder is not a substitute for deciding what belongs in it. Do not use
Kiln's private state namespace for Tesota. Machine-specific reference checkout
paths are local working context, not documentation prerequisites.

When moving documentation, update links and inspect references from code and
tests. Preserve historical machine evidence bytes; update all consumers when moving files. Check relative
links, command spelling and source claims; keep temporary validation scripts out
of the final change. Do not add empty documentation categories or placeholder pages.
