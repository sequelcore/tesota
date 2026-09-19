# Using Tesota

Tesota is a pre-release, terminal-first agent. You can ask it bounded questions
about a repository or ask it to attempt one narrowly supported TypeScript
change. The same conversation shows the proposed scope, asks for approval,
works in an isolated checkout, presents applicable checks and lets you review
and apply the result.

This guide describes the current supported workflow. The [roadmap](roadmap.md)
owns what comes next.

## Prerequisites

Install the pinned Bun and Node versions from [package.json](../package.json),
then build and link this development checkout:

```console
bun install --frozen-lockfile --ignore-scripts
bun run build
bun link
```

The current change workflow also requires Git and Docker Desktop on Windows,
the pinned verification image already present locally and a matching TypeScript
installation in the target repository. It does not install dependencies or pull
an image while working. Docker belongs to the current protected TypeScript
route; it is not intended as a permanent prerequisite for every Tesota task.

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
Tesota may ask one clarification while preserving the same committed baseline.

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

## One supported change

The current source-task contract allows:

- one or two existing, non-test, non-declaration files matching
  `src/**/*.ts`;
- bounded file reads and exact replacements;
- an initial check before the first replacement;
- up to two replacements and three checks within the cumulative task budget;
- scope-integrity checking and the fixed `typescript-no-emit/v1` profile; and
- human review of the escaped exact diff before application.

It excludes tests, dependency and check configuration, file creation, deletion
or renaming, migrations, arbitrary shell commands and network access. The model
cannot select a replacement check or weaken its configuration.

After approval, Tesota creates an isolated result and begins work. A failed
check can supply diagnostics for another bounded edit. Every changed result has
its own identity, so evidence for an earlier version does not silently apply to
the later one.

## Review the result

The review should answer four separate questions:

1. What changed?
2. Which claims were checked for this exact result?
3. What remains unestablished or needs human judgment?
4. Has the result been applied to the working repository?

Today Tesota shows the exact diff, recorded check outcomes and the limits of
the current TypeScript profile. That profile can establish that the admitted
TypeScript invocation passed for the bound result and conditions. It does not
establish the requested runtime behavior, a complete integration suite or
universal correctness.

Accepting a result records a human decision. Application is a separate,
conflict-checked effect. Rejecting it retains the evidence without changing the
source repository.

After scope decline, failed execution, candidate rejection or confirmed
application, Tesota reports the retained outcome and returns to a new prompt.
Cancellation, a lifecycle failure or unconfirmed application settlement still
ends the session so that a new request cannot conceal uncertain effects.
Tesota does not yet accept semantic feedback such as “keep the fix but change
this part” within the same task. That is a later roadmap capability.

## Inspect or recover work

The ordinary supported path does not require copying proposal, candidate or
review IDs. Those identifiers exist for precise diagnostics and lower-level
operations:

```console
tesota candidate list
tesota candidate inspect <id-or-directory>
tesota task outcome <proposal-id>
```

The outcome record reports elapsed time, observed model, tool and edit counts,
the first-check result, the review decision and application state. Token usage
and monetary cost remain unavailable because the current producer does not
observe them.

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
- edit tests or create, delete or rename files in the supported task;
- continue the same task with semantic feedback after review;
- accept user-requested semantic revision of a result;
- resume an interrupted task; or
- claim that the live end-to-end workflow is qualified across representative
  external repositories.

See the [roadmap](roadmap.md) for capability priorities and
[qualification](qualification.md) for the evidence required to advance them.
