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
| `bun run test:fast` | Run deterministic in-worker tests for quick feedback; it launches no external process |
| `bun run test` | Build, then run core and filesystem-heavy Vitest groups in isolated processes |
| `bun run lint` | Check source and tests; no fixes, warnings rejected |
| `bun run check` | Run the complete repository gate |
| `bun run formal:check` | Run the standalone LemmaScript/Dafny proof for the invocation-admission predicate; requires external Dafny and is not part of `bun run check` |
| `bun link` / `bun unlink` | Register or remove this checkout's global `tesota` development command |
| `bun --no-env-file dist/cli.js isolation qualify` | Run the explicit live Windows isolation comparison; excluded from normal checks |

The [verification reference](verification.md#current-check-and-review-paths) is the
task-oriented map for Oxlint, the standalone LemmaScript/Dafny formal check and
the optional Gentle review provider. It records each path's prerequisites,
evidence subject, participation in the supported flow and limitations.
`bun run check` does not invoke `formal:check` or a live review provider.

The package-owned `tesota` binary targets `dist/cli.js` and runs through the
pinned Bun runtime. Build before the first `bun link`; later `check` and `build`
commands refresh the linked executable because the registration continues to
point at this checkout. This is a reversible development link, not a release
installation.

With no arguments, the main CLI opens Tesota Shell when standard input, output and
error are interactive terminals. It accepts a natural-language message. Bounded
discovery can answer a repository question, ask one clarification or retain a
proposal for a requested change. An answer returns to the prompt. A clarification
answer continues the original request only against the same committed baseline;
blank input ends the session or cancels the pending clarification. A ready supported
TypeScript source proposal continues to its explicit approval and review flow. The
persistent renderer keeps the transcript, current phase, elapsed time and editor
visible while the terminal resizes or scrolls. Ctrl+C cancels a pending prompt; in
discovery or execution it reaches the application owner. Those observations and
controls grant no authority. The surface is named **Tesota Shell**; “TUI” is only
its implementation category.
With no arguments in a non-interactive process, or with
`help`, `--help` or `-h`, it prints help (exit 0).
`candidate create` and `candidate inspect <id|directory>` prepare and inspect
[independent checkouts](candidates.md); they do not invoke a model.
`candidate check typecheck <id|directory>` prepares the sole admitted repository
check profile and requires explicit interactive approval. It never evaluates a
model-controlled command: only the exact canonical declaration is accepted and
Tesota invokes its fixed TypeScript argv inside the pinned, network-disabled,
read-only container policy. This Windows development slice requires Docker
Desktop, the pinned image already present locally and a matching TypeScript
closure in the source repository. Provision it from the committed
lockfile with `bun install --frozen-lockfile --ignore-scripts --os=linux
--cpu=x64`; when TypeScript declares a platform package, the closure must
include `@typescript/typescript-linux-x64` at the declared TypeScript version.
Portable JavaScript TypeScript releases do not declare that package. Tesota
performs no install or image pull.
That Docker requirement belongs to the current profile, not every Tesota
operation; [decision 007](decisions/007-execution-environments.md) owns the
long-term execution-environment policy.
`isolation qualify` runs the same fixed probe in the installed Codex Windows
sandbox and a pinned Docker container. It selects a backend only when every
filesystem, synthetic-credential, network, descendant and cancellation control
passes. It creates only temporary fixtures, invokes no model and grants no task
execution authority. See the [qualification record](../experiments/isolation/README.md).
`candidate list` summarizes stored candidates by lifecycle status, and
`candidate clean` removes only old rejected, abandoned or failed checkout directories while
retaining their evidence. `candidate abandon <id|directory>` records an explicit
operator decision for work that no longer needs review.
`task propose <request>` uses the saved login for bounded read-only discovery over
the current repository's committed baseline. It retains a proposal with no execution authority,
creates no candidate and never runs in the normal check suite. See
[task proposals](proposals.md).
`task start <proposal-id>` is the composable seam behind the shell continuation.
It requires an interactive Windows terminal and admits only a current ready
proposal for one or two existing TypeScript files below `src/`. Approval creates
a fresh candidate; replay and resume are rejected. The current checks establish
scope integrity and run the exact contained `typescript-no-emit/v1` profile while
explicitly leaving outcome correctness to human review. Repository check
configuration, dependency declarations, test and file-lifecycle changes remain denied. A
later accept/reject question is bound to the escaped diff;
acceptance invokes conflict-safe promotion without requiring another ID. At the
first passing review, the operator may instead request one bounded semantic
correction, approve it separately, review fresh R1 evidence and make a final
accept/reject decision. Failed or uncertain R1 never falls back to R0.
`task outcome <proposal-id>` reloads the proposal-bound outcome journal. It
reports elapsed time, first-check status, observed edit and other operation
counts, explicit execution causes, operator decision and promotion state. Token
usage and monetary cost are reported as unavailable because the current
execution producer does not observe them. The outcome is evidence for inspection;
it grants no execution, acceptance or promotion authority.
`task run gentle-review <candidate> <gentle-ai-executable> <lineage-id>`
collects one reviewer slot currently offered by Gentle. It requires an existing
candidate and an existing provider lineage whose current status offers that
slot; the command does not create or start a lineage. The executable path must
be absolute and identify the stable Gentle AI 2.8.0 binary. After upgrading,
run the provider-owned `gentle-ai sync` operation before review so its managed
assets match the binary. Tesota negotiates capabilities protocol 2.5, verifies
the executable's locally calculated SHA-256 against its self-report, requires
the non-legacy features used by the qualified lifecycle and accepts only STATUS
v7 with compact-v2 authority. Tesota preserves the provider's prompt and binding,
runs tool-free Codex inference with the saved login, and submits only after the
same binding is observed again. Run the command again for the next offered
slot. START consent, acknowledgement, Tesota human acceptance and source
promotion remain separate operations; review never authorizes promotion. See
[Gentle AI review provider](verification.md#gentle-ai-review-provider) for the
evidence and authority boundary.
An approved terminal response returns its identity-bound per-lens reviewer
evidence; an escalated status or closure returns the provider's canonical cause,
finding IDs and available refuter outcomes. These are inspectable evidence, not
acceptance or command authority. Tesota does not automatically run the offered
acknowledgement.
If model inference fails, the command submits nothing. Retry only through a new
explicit command after bound status still offers the slot; this is capture
re-entry, not reconstructed `review.recover` authority.
Gentle's targeted validator launches a locked-down `pi` process. The compiled
`dist/pi-review-relay.js` is Tesota's credential-preserving implementation of
that process contract: it admits the fixed tool-free argv and Gentle 2.8's
optional model/thinking suffix only when it names Tesota's fixed reviewer route. It never copies
OAuth credentials into Pi's default store. Gentle remains responsible for the
isolated process, prompt and verdict admission.
`task review <directory>` and `task decide <directory> <accept|reject> <review-sha256>`
provide offline review and local decision recording; neither promotes code.
`task promote <directory> <review-sha256>` explicitly applies an accepted
admitted write set from the original source root
after checking for conflicting source work.
`verify <file.ts|file.js>` runs the
[Oxlint single-file static profile](verification.md#oxlint-single-file-static-profile);
unsupported arguments print a diagnostic on stderr and exit 2.

Tests exercise real Oxlint, controlled Pi boundaries and compiled CLI processes.
Use `test:fast` while changing pure orchestration or contracts, then run the
smallest affected process-backed test file. The complete `test` command remains
the qualification gate: new tests are excluded from the fast set until their
implementation is explicitly confirmed not to launch Git, a compiler, a CLI, a
verifier, a provider or another operating-system process.
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
| Product identity, thesis, vocabulary and purpose | [Identity](identity.md) |
| Complete supported user workflow and current limitations | [Using Tesota](using-tesota.md) |
| Public market comparison evidence | [Public positioning](references/public-positioning.md) |
| Implemented structure and boundaries | [Architecture](architecture.md) |
| Product direction, current status and priority | [Roadmap](roadmap.md), as the sole owner |
| Evidence required to qualify roadmap capabilities | [Qualification](qualification.md) |
| Stable behavioral contracts and usage | [Verification](verification.md) |
| Verifier selection and qualification criteria; not product priority | [Verifier strategy](verifier-strategy.md) |
| Authentication and private credential lifecycle | [Authentication](authentication.md) |
| Candidate checkout creation and inspection | [Candidate checkouts](candidates.md) |
| Task scope and source checks | [Scoped candidate task](tasks.md) |
| Read-only conversational discovery and proposal records | [Task proposals](proposals.md) |
| Experimental guides and records | [experiments/](../experiments/README.md), grouped by capability |
| Consequential decisions and rationale | `docs/decisions/`, linked from the relevant guide |
| Selected upstream source and reuse | `docs/references/`; [Kiln extraction](references/kiln-extraction.md) owns the dated selective-recovery classification, not current priorities |
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
