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
| `bun run test` | Build, then run core and filesystem-heavy Vitest groups in isolated processes |
| `bun run lint` | Check source and tests; no fixes, warnings rejected |
| `bun run check` | Run the complete repository gate |

With no arguments, the main CLI opens Tesota Shell when standard input, output and
error are interactive terminals. It accepts a natural-language message. Bounded
discovery can answer a repository question, ask one clarification or retain a
proposal for a requested change. An answer returns to the prompt. A clarification
answer continues the original request only against the same committed baseline;
blank input ends the session or cancels the pending clarification. A ready supported
documentation proposal continues to its explicit approval and review flow. The
persistent renderer keeps the transcript, current phase, elapsed time and editor
visible while the terminal resizes or scrolls. Ctrl+C cancels a pending prompt; in
discovery or execution it reaches the application owner. Those observations and
controls grant no authority. The surface is named **Tesota Shell**; “TUI” is only
its implementation category.
With no arguments in a non-interactive process, or with
`help`, `--help` or `-h`, it prints help (exit 0).
`candidate create` and `candidate inspect <id|directory>` prepare and inspect
[independent checkouts](candidates.md); they do not invoke a model.
`candidate list` summarizes stored candidates by lifecycle status, and
`candidate clean` removes only old rejected, abandoned or failed checkout directories while
retaining their evidence. `candidate abandon <id|directory>` records an explicit
operator decision for work that no longer needs review.
`task prepare <directory>` and `task check <directory>` expose the default
[registered task](tasks.md), also without model inference.
`task run` creates a fresh candidate and runs the selected fixed task with the saved login;
it is a separate live command and is never invoked by the normal check suite.
`task propose <request>` uses the saved login for bounded read-only discovery over
Tesota's committed baseline. It retains a proposal with no execution authority,
creates no candidate and never runs in the normal check suite. See
[task proposals](proposals.md).
`task start <proposal-id>` is the composable seam behind the shell continuation.
It requires an interactive Windows terminal and admits only a current ready
proposal for one existing Markdown file below `docs/`. Approval creates a fresh
candidate; replay and resume are rejected. The first slice runs only Tesota's
scope-integrity check and explicitly reports that the declarative repository
check did not run. A later accept/reject question is bound to the escaped diff;
acceptance invokes conflict-safe promotion without requiring another ID.
`task recover <candidate>` explicitly retries a failed or incomplete registered
task in a clean successor at the same baseline. It never resumes the prior model
session or copies that candidate's working bytes or evidence.
`task run gentle-review <candidate> <gentle-ai-executable> <lineage-id>`
collects one reviewer slot currently offered by Gentle. The executable path
must be absolute and identify the package-local, version-qualified Gentle AI
binary. Tesota preserves the provider's prompt and binding, runs tool-free
Codex inference with the saved login, and submits only after the same binding
is observed again. Run the command again for the next offered slot. Other
provider transitions, including START consent and acknowledgement, remain
explicit lifecycle operations; review never authorizes promotion.
If model inference fails, the command submits nothing. Retry only through a new
explicit command after bound status still offers the slot; this is capture
re-entry, not reconstructed `review.recover` authority.
Gentle's targeted validator launches a fixed `pi` process. The compiled
`dist/pi-review-relay.js` is Tesota's credential-preserving implementation of
that process contract: it admits only the fixed tool-free argv and never copies
OAuth credentials into Pi's default store. Gentle remains responsible for the
isolated process, prompt and verdict admission.
`task review <directory>` and `task decide <directory> <accept|reject> <review-sha256>`
provide offline review and local decision recording; neither promotes code.
`task promote <directory> <review-sha256>` explicitly applies an accepted
promotable registered or admitted write set from the original source root
after checking for conflicting source work.
`verify <file.ts|file.js>` runs the [bounded check](verification.md); unsupported
arguments print a diagnostic on stderr and exit 2.

Tests exercise real Oxlint, controlled Pi boundaries and compiled CLI processes.
The repository lint configuration applies Oxlint's classic cyclomatic-complexity
limit of 20 to every function in `src` and `tests`; it has no baseline or
file-level exceptions and remains separate from the candidate verifier profile.
Normal checks do not log in or invoke a live model. Network experiments have a
separate [operating guide](../experiments/codex/README.md). Filesystem-heavy
candidate suites run in separate Vitest processes so a timed-out filesystem
operation cannot contaminate later suites; they retain the same isolated worker
model and per-test limits. The CI workflow gives its Windows and Linux checks 20
minutes; a declared lane does not establish that it has run successfully.

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
| Authentication and private credential lifecycle | [Authentication](authentication.md) |
| Candidate checkout creation and inspection | [Candidate checkouts](candidates.md) |
| Task scope and documentation check | [Scoped candidate task](tasks.md) |
| Read-only conversational discovery and proposal records | [Task proposals](proposals.md) |
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
