# Tesota builds its own engine

Date: 2026-10-15
Status: Accepted by the owner. Nothing is built yet. This decision revises part
of the [2026-10-08 decision](2026-10-08-verification-layer.md).

## Decision

Tesota keeps its purpose. It makes the agent show evidence that its change does
what was asked, it verifies results and not actions, and it has no verifier of
its own. What changes is the host: Tesota stops running inside Pi and gets its
own engine and terminal shell. The repository holds two Bun packages.

| Package | Owns |
| --- | --- |
| `@tesota/core` | The engine: agent loop, tools, sessions, extension API and the session lifecycle. Verification is a mandatory step of that lifecycle. |
| `tesota` | The `tesota` command, a terminal shell built with `pi-tui` that has a sidebar of sessions, the `tesota receipt` command and the renderers. |

- **Verification is part of the lifecycle; it is not an extension.**
  - A session settles in this order: ordinary extensions settle, then
    verification runs, then the session ends with its receipt.
  - No extension can replace the gate's decision or its evidence.
  - If verification fails to run, the session ends as "incomplete", never as
    "done". The outcomes Tesota already reports, such as "no progress" and "not
    verified", stay as they are.
  - The verification code is a separate module inside `@tesota/core`. It becomes
    its own package only when a second consumer needs it, for example running
    the gate inside Claude Code or Codex through their hooks.
- **The scope is what Tesota uses from Pi today, and no more.** That covers:
  - sessions: create, persist and resume, in Tesota's own format;
  - the loop and tools;
  - events: session start, input, tool start, tool result, and settle with
    send-back;
  - the extension API: tools, flags, message renderers, active tools, the
    model and model completion, the working directory, context usage and the
    abort signal;
  - compaction.

  The full list is inventoried from the code before the engine's scope is
  closed. Channels, gateways and other surfaces are left out until a real
  consumer needs them.
- **Pi is the reference implementation.** The same contract tests run against
  an adapter for a pinned Pi version and against `@tesota/core`. A capability
  is done when it passes them. Tesota's stronger guarantees, such as mandatory
  verification and the request ledger, get tests of their own.
- **Some of Pi stays.**
  - `@earendil-works/pi-ai` provides model providers and sign-in. It will be
    replaced only if it causes problems it does not solve.
  - `@earendil-works/pi-tui` draws the terminal UI. It was chosen over Ink and
    OpenTUI because Tesota's current interface already uses it, it runs on Bun,
    and Pi's message components can be reused.
- **Compatibility comes through shared standards, not one adapter per
  harness.** The engine supports:
  - Agent Skills (`SKILL.md`);
  - MCP;
  - `AGENTS.md`;
  - command hooks with the event names Claude Code and Codex share;
  - Pi's TypeScript extension API, for the parts Tesota uses.

  Each event's payload, ordering, failure behavior and continuation are
  specified, and conformance tests check them.
- **Parallel sessions get one worktree each.** A folder that is not a Git
  repository uses a snapshot instead. A session's workspace binding governs its
  execution, diffs, verification and cleanup.
- **Permissions.**
  - Three modes: read only, ask, and full access.
  - Rules are stored as data, not code.
  - A floor of rules applies even in full access.
  - The same boundary covers built-in tools, MCP and extensions.
  - There is still no sandbox of Tesota's own. An existing OS sandbox will be
    reused when automated contexts need one.
- **Nothing legacy is kept.** There are no external consumers and nothing is
  published. Tesota is no longer distributed as a Pi package, and earlier
  sessions do not carry over.
- **The alpha waits for the engine.**
- **Other surfaces come later.** A GUI waits until Tesota is stable. An ACP
  server is recommended by the study, but waits for a real client. The engine
  must leave room for both without needing a redesign.

## Why

Pi limits features that Tesota needs:

- **Settlement.** Pi's own maintainers track settlement as an open problem
  ([pi#5886](https://github.com/earendil-works/pi/issues/5886)).
- **Overwritten verdicts.** At settle, a later extension handler replaces
  earlier handlers' entries and send-back. An exception in a handler is only
  logged (`emitBoundary` in Pi's extension runner).
- **Cancellation.** Verification cannot be cancelled during final settlement
  ([#408](https://github.com/sequelcore/tesota/issues/408),
  [pi#10928](https://github.com/earendil-works/pi/issues/10928)).
- **Parallel sessions.** Pi's interactive mode keeps a single live session,
  because switching sessions disposes the previous one. In RPC mode, the
  header, footer, editor and working indicator do nothing. Parallel sessions
  ([#373](https://github.com/sequelcore/tesota/issues/373)) and Tesota's own
  interface therefore cannot be built on Pi's CLI.

The [engine study](../design/engine-study.md) found that every harness it read
treats "the model stopped" as "the work is done", and that compaction loses the
original request. Those are exactly the gaps Tesota exists to close. They
belong in the host's lifecycle, not in an extension that sits on top of it.

The owner also wants control over Tesota's interface and less strategic
dependence on another project. Harness engineering is a capability Sequel
chooses to own.

## Evidence

Two experiments ran on 2026-10-15 against Pi 1.3.0 with a scripted model. They
were not committed.

- **Several SDK sessions in one process.** One process created two sessions at
  the same time. Each loaded Tesota's extension and a settle hook. The hook sent
  each session back once, and each session answered again. Usage was reported
  per session.
- **A `pi-tui` sidebar and transcript over two live sessions.** Switching the
  visible session while both were running worked, and Pi's message components
  rendered the transcript.

GPT-6 Astra reviewed the package layout against the source of Pi, oh-my-pi,
Gemini CLI, Qwen Code, Codex and OpenCode:

- It agreed with two packages.
- It rejected verification as an ordinary built-in extension, for the
  settlement reasons above.
- Its gaps are now requirements: durable request state across compaction, a
  workspace policy for parallel sessions, an owner for permissions,
  hook-compatibility semantics, and the `modelRegistry` call missing from the
  contract inventory.

The rejected alternatives were:

- staying a Pi package, which does not deliver the shell or the settlement
  guarantees;
- forking Pi, which means carrying about 194,000 lines that change about twenty
  times a day;
- an engine from scratch, which would rebuild model access as well.

## Guarding against Kiln

Kiln grew an engine, a gateway, channels and surfaces at the same time, for
consumers that did not exist, and was frozen. The guard here is scope:

- every capability serves a consumer that exists today;
- Pi's tests set the target;
- model access stays in `pi-ai`;
- the work lands in slices, each with its own issue and pull request.

## What changes from 2026-10-08

These parts of the 2026-10-08 decision are reversed:

- shipping as a Pi package;
- running only inside Pi;
- not rebuilding a session engine.

The 2026-10-09 clarification about composing through Pi's extension points no
longer applies.

These parts still stand:

- verification of results, not actions;
- no verifier of Tesota's own;
- no sandbox of Tesota's own;
- Tesota is not a security boundary;
- a passing check is not acceptance.

## Consequences

- Until the engine passes its contract, the current Pi package stays the only
  working Tesota. Work on it is limited to fixes.
- Parallel sessions on Pi's public APIs
  ([#373](https://github.com/sequelcore/tesota/issues/373)) and choosing which
  Pi packages to carry ([#385](https://github.com/sequelcore/tesota/issues/385))
  are replaced by the engine and its shell.
- The remote host decision
  ([2026-10-13](2026-10-13-remote-session-host.md)) relies on Pi's RPC. It is
  reviewed once the engine exists.
- The README and the verification design change when the engine replaces Pi,
  not before.
