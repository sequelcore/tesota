# Using Tesota

Tesota is a pre-release, terminal-first agent. You can ask it bounded questions
about a repository or ask it to attempt one narrowly supported TypeScript
change. The same conversation shows the proposed scope, asks for approval,
works in an isolated checkout, presents applicable checks and lets you review
and apply the result.

This guide describes the current supported workflow. The [roadmap](roadmap.md)
owns what comes next. Continuous read-only questions and the initial approved
source-task turn share one in-memory Pi conversation. The later continuous
source-and-test workflow has a bounded implementation for one existing source
and test file, but useful live completion and fresh external qualification remain
outstanding. General test edits and interrupted-task resume remain unsupported.

## Prerequisites

Install the pinned Bun and Node versions from [package.json](../package.json),
then build and link this development checkout:

```console
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
```

The current change workflow also requires Git and Docker Desktop on Windows
and the pinned verification image already present locally. The source-only
TypeScript profile additionally requires a matching TypeScript closure in the
target repository. Prepare that closure in an
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
working. Docker belongs to the current protected TypeScript route; it is not
intended as a permanent prerequisite for every Tesota task.

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

Then describe what you need:

```text
> Explain how session expiry is handled.
```

A bounded read-only question can end with an answer and return to the prompt.
Related follow-up questions and corrections reuse the same in-memory Pi
conversation, so they receive the earlier transcript. A separate `tesota`
process starts an isolated conversation. Tesota may ask one clarification while
preserving the same committed baseline.

Each read-only turn receives a fresh bounded reader for the current committed baseline.
The conversation stops if the baseline or relevant dirty-path state changes;
earlier observations are not presented as current. Pressing Ctrl+C during a
read-only turn closes that reader and cancels the SDK operation. Tesota returns
to a prompt only after settlement is confirmed. Unconfirmed settlement ends the
session.

Repository reads keep their existing per-turn operation and byte limits. One
conversation admits at most 12 discovery turns, 36 model invocations and 96 tool
calls across discovery and its initial approved task turn. The task also keeps
its separate cumulative R0/R1 limits.
Automatic SDK retries and compaction are disabled. A timeout, exhausted budget
or context-window failure is reported without silently resetting history or
changing the provider. Conversations are not saved to disk and cannot be
resumed after process exit.

For a change request:

```text
> Fix the session timeout bug.
```

Tesota first inspects the committed repository state. If the task fits the
current contract, it presents the files it proposes to change and the checks it
will use. This is the user-facing form of the work proposal and access request.
No write authority exists until you approve that scope.

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
then pass after the repair. Its fixed Node test runs in the protected container;
it does not typecheck or run the full repository suite. This variant is still
awaiting a complete ordinary live walkthrough and fresh external evaluation.

The source-only variant excludes tests; both variants exclude dependency and
check configuration, file creation, deletion
or renaming, migrations, arbitrary shell commands and network access. The model
cannot select a replacement check or weaken its configuration.

After approval, Tesota creates an isolated result and exposes only the task's
approved read, replace and check tools for the R0 turn in the same in-memory
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
integration suite explicitly unestablished. It then shows the escaped exact
diff. The terminal outcome distinguishes applied, not applied and unconfirmed
application.

The TypeScript or targeted Node profile can establish that the admitted invocation passed for
the bound result and conditions. It does not establish requested behavior,
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

Interrupted work cannot yet be resumed. Durable facts can be inspected, but
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
