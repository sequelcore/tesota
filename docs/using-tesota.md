# Using Tesota

Tesota is a pre-release, terminal-first agent. You can ask it bounded questions
about a repository or ask it to attempt one narrowly supported TypeScript
change. The same conversation shows the proposed scope, asks for approval,
works in an isolated checkout, presents applicable checks and lets you review
and apply the result.

This guide describes the current supported workflow. The [roadmap](roadmap.md)
owns what comes next. Continuous read-only questions and the initial approved
source-task turn share one bounded Pi conversation within a Tesota session. The later continuous
source-and-test workflow has a bounded implementation for one existing source
and test file and two accepted live walkthroughs. Broader external qualification
remains outstanding. General test edits and interrupted-task resume remain
unsupported.

## Prerequisites

Install the pinned Bun and Node versions from [package.json](../package.json),
then build and link this development checkout:

```console
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
```

The current change workflow requires Git on Windows. The shell defaults to
trusted local checks. Before approval it states that these checks can access
host files, network and credentials; they are not sandboxed. Tesota observes
the main check process but cannot establish that child processes have ended
or that the check used no other host inputs. To select the
protected Docker route, start `tesota --execution docker-contained`. That route
requires Docker Desktop and the pinned verification image already present
locally. The TypeScript profile requires a matching TypeScript installation in
the target repository. For the Docker route, prepare a Linux/x64 closure in an
independent checkout with the repository's committed lockfile:

```powershell
bun install --frozen-lockfile --ignore-scripts --os=linux --cpu=x64
```

The resulting `node_modules` must contain `typescript` at the exact declared
version. If that installed package declares `@typescript/typescript-linux-x64`,
the closure must contain that package at the same version. Portable JavaScript
TypeScript releases have no platform package; platform-specific releases must
be prepared for Linux/x64 and may not run repository tools directly on the
Windows host. Tesota does not install dependencies or pull an image while
working. The environment is selected before approval and cannot silently
change after it.

Authenticate the current Codex model route once:

```console
tesota auth login
```

Credentials remain private local state. They are not copied into task records,
instructions or candidate results. See [authentication](authentication.md).

## Start a conversation

From the repository you want to inspect:

```console
cd my-project
tesota
```

To try the shell appearance, launch it with `tesota --theme tesota-dark`
(the default), `tesota --theme tesota-light`, or `tesota --theme terminal`.
Use the dark or light variant with a matching terminal profile; `terminal` leaves
color choices to the terminal. This selection lasts for one invocation and
does not change task permissions or verification results.

Then describe what you need:

```text
> Explain how session expiry is handled.
```

A bounded read-only question can end with an answer and return to the prompt.
Related follow-up questions and corrections reuse the same Pi conversation,
so they receive the earlier transcript. The shell retains sessions locally
and reopens settled Pi context after a normal restart. Tesota may ask one
clarification while preserving the same committed baseline.

The left column lists conversations. The selected conversation owns the
composer and status at its bottom; its latest answer, proposal or candidate
review appears in the right inspector. Earlier results can be inspected, but
a pending decision always applies to the latest result named by its prompt.
At wide sizes, `Alt+S` toggles a second, read-only conversation pane. On a
narrow terminal, `Alt+1`, `Alt+2` and `Alt+3` show sessions, conversation and
inspector respectively. `Alt+J` (or `Ctrl+Tab` when the terminal sends it)
selects the next session, `Ctrl+N` creates a new one, `Alt+,` and `Alt+.`
browse inspected results, and `Ctrl+Q`
closes the shell. The selected conversation is always the input target.

Each read-only turn receives a fresh bounded reader for the current committed
baseline. If repository state changes between ordinary requests, the shell
refreshes model context and checks the request against the new state while
carrying forward the consumed budget. A clarification tied to an older baseline
stops, because its original question may no longer apply. Earlier observations
are not presented as current. Pressing Ctrl+C during a
read-only turn closes that reader and cancels the SDK operation. Tesota returns
to a prompt only after settlement is confirmed. Unconfirmed settlement ends the
session.

Repository reads keep their existing per-turn operation and byte limits. One
conversation admits at most 12 discovery turns, 36 model invocations and 96 tool
calls across discovery and its initial approved task turn. The task also keeps
its separate cumulative R0/R1 limits.
Automatic SDK retries and compaction are disabled. A timeout, exhausted budget
or context-window failure is reported without silently resetting history or
changing the provider. Tesota saves the human transcript and Pi's settled
context in separate local records under `~/.tesota/`. A reopened conversation
retains the budget it already spent. A stopped operation is not resumed; if it
was interrupted, the next engine context is fresh and earlier approval is not
restored. Unconfirmed effects block further work in that conversation. Inspect
the retained task record before beginning separate work.

For a change request:

```text
> Fix the session timeout bug.
```

Tesota first inspects the committed repository state. If the task fits the
current contract, it presents the files it proposes to change and the checks it
will use. This is the user-facing form of the work proposal and access request.
No write authority exists until you approve that scope.
Before approval, `task start` inspects the prerequisites for the fixed checks
from the committed files and local verifier installation. For a source-and-test
task, you choose the targeted Node test alone or the Node test plus TypeScript
typecheck when both are eligible. Every selected check is required. Tesota
shows an ineligible reason before the choice; if the required test cannot run,
it stops without asking for approval or creating a candidate. This is a
read-only preview, not a check result:
candidate admission and execution revalidate their own inputs, and the selected
execution environment may still fail when the check runs.

If the request is unsupported, Tesota should explain the boundary rather than
pretend it can complete the work.

## Bounded supported changes

The current source-task contract allows:

- one or two existing, non-test, non-declaration files matching
  `src/**/*.ts`;
- bounded file reads and exact replacements;
- an initial check before the first replacement;
- up to two replacements and three checks within the cumulative task budget;
- scope-integrity checking and the fixed `typescript-no-emit/v1` profile; and
- human review of the escaped exact diff before application.

After a passing initial result, the review offers accept, reject or one semantic
correction. The correction must stay inside the original scope, receives an
explicit approval, uses the remaining task-wide budget and produces fresh R1
checks and review identity. A no-op R1 is allowed when truthful, but still needs
a fresh final decision because its semantic criteria changed.

The separate source-and-test variant permits one existing TypeScript source
file and one existing `tests/**/*.test.ts` file, with exact paths approved up
front. It allows up to six replacements and six checks across the initial work
and one approved correction. The test must first fail on the original source,
then pass after the repair without changing that demonstrated regression. Its
fixed Node test runs in the selected environment; when selected, the selected
typecheck must also pass on the same final candidate. Neither runs the full
repository suite. Its two accepted
ordinary walkthroughs include one fresh external task, but do not establish
representative usefulness.

The source-only variant excludes tests; both variants exclude dependency and
check configuration, file creation, deletion
or renaming, migrations, arbitrary shell commands and network access. The model
cannot select a replacement check or weaken its configuration.

After approval, Tesota creates an isolated result and exposes only the task's
approved read, replace and check tools for the R0 turn in the same bounded Pi
conversation. A failed
check can supply diagnostics for another bounded edit. Every changed result has
its own identity, so evidence for an earlier version does not silently apply to
the later one.

## Review the result

The review should answer four separate questions:

1. What changed?
2. Which claims were checked for this exact result?
3. What remains unestablished or needs human judgment?
4. Has the result been applied to the working repository?

Today Tesota lists the changed files, names scope integrity and the applicable
contained check separately, states that the candidate has not yet been
applied and keeps requested behavior, completion conditions and the full
integration suite explicitly unestablished. The shell inspector shows the
exact diff as text; lower-level task output retains its escaped representation.
The terminal outcome distinguishes applied, not applied and unconfirmed application.

The selected TypeScript and targeted Node profiles can establish that their admitted invocations passed for
the bound result and conditions. They do not establish requested behavior,
completion conditions, a complete integration suite or universal correctness.

Accepting a result records a human decision. Application is a separate,
conflict-checked effect. Rejecting it retains the evidence without changing the
source repository.

After any known-settled outcome, including scope decline, cancellation, failed
execution, candidate rejection or confirmed application, Tesota reports the
retained outcome and returns to a new prompt. Unconfirmed execution or
application settlement ends the session so that a new request cannot conceal
uncertain effects.
If R1 fails, is cancelled or has unconfirmed settlement, Tesota does not offer
the earlier R0 result as a fallback. Only final accepted R1 bytes can be applied.

## Inspect or recover work

The ordinary supported path does not require copying proposal, candidate or
review IDs. Those identifiers exist for precise diagnostics and lower-level
operations:

```console
tesota candidate list
tesota candidate inspect <id-or-directory>
tesota task outcome <proposal-id>
```

The outcome record reports elapsed time, observed model, tool, read, edit,
model-loop check and host-side check counts, the first-check result, execution
causes, the review decision and application state. Host checks are reported as
work rather than limited by a new ceiling. Token usage and monetary cost remain
unavailable because the current producer does not observe them.

Interrupted work cannot yet be resumed. A session's conversation and prior
results can be revisited, but that does not restart an interrupted task.
Durable facts can be inspected, but
recovery does not recreate expired approval or execution authority. If Tesota
cannot confirm that an effect ended, that uncertainty must remain visible.

Contributor-oriented commands such as `task start`, standalone candidate checks,
offline review and explicit promotion are documented in
[development](development.md), [task proposals](proposals.md),
[tasks](tasks.md), [candidate checkouts](candidates.md) and
[verification](verification.md).

## Current limitations

Tesota is not yet a general coding agent or a general-purpose agent. It cannot
currently:

- make arbitrary repository changes;
- run model-selected shell commands or install dependencies;
- edit arbitrary tests or create, delete or rename files in the supported task;
- request more than one semantic correction in the same task;
- resume an interrupted task; or
- claim that the live end-to-end workflow is qualified across representative
  external repositories.

See the [roadmap](roadmap.md) for capability priorities and
[qualification](qualification.md) for the evidence required to advance them.

The narrow request-to-application flow has one successful prospective
Windows/Docker case with explicit human acceptance. Its retained failures,
behavioral checks and operator-reported external review are documented in the
[qualification results](../experiments/supported-task/results.md). This is not
a claim of representative reliability or live qualification on other platforms.
