# What fails in coding-agent harnesses

This study, from 2026-10-15, is the input to Tesota's engine
([decision record](../decisions/2026-10-15-own-engine.md)). It records what
fails in existing harnesses, and the requirements that follow for
`@tesota/core`.

Claude Opus 5.5 covered Pi, Claude Code and the source-code study of eleven
harnesses, [arXiv 2609.00006](https://arxiv.org/abs/2609.00006). GPT-6 Astra
covered Codex, OpenCode, Gemini CLI and t3code.

- Issue counts are comments (C) and reactions (R) on 2026-10-15.
- A closed issue does not prove the problem was fixed.
- The reports were not reproduced here, except where this document says so.
- Revisions read: Codex `a45b8ccb`, OpenCode/dev `723a2f68`, Gemini `b25669d8`,
  t3code `ba358222`, and the Pi clone at `4954d760`.

## Findings by area

### 1. Settlement: "the model stopped" is not "the work is done"

- **Pi.** [#5886] is open, and the maintainer calls it a meta-issue. `agent_end`
  only means the low-level loop ended. Retries, compaction, queued messages and
  extension handlers can still run afterwards, which creates false-idle states and
  continuations that act on stale data. The maintainer's analysis is that correct
  settlement needs continuation intent and generations for sessions and runs.
- **Pi, related reports:**
  - #10031: the session is stuck in "Working…" after Esc.
  - #6234: Esc leaves the session stuck when an extension's hook never settles.
  - #10664: Pi reports done while subagents are still running. It was closed as
    not planned.
  - Tesota #408: verification cannot be cancelled while Pi settles the final answer.
- **Pi's extension runner.** At settle, a later handler replaces the earlier
  handlers' `entries` and `continue`, and an exception is only logged
  (`runner.ts` `emitBoundary`; checked).
- **Codex:**
  - The Stop hook result is computed as `should_block = !should_stop && any(block)`
    (`codex-rs/hooks/src/events/stop.rs:419`; checked). One hook asking to stop
    therefore overrides another hook's veto.
  - [#34866]: the run reports "completed" while the command it wrapped is still
    running.
  - [#21160]: when a usage limit ends the run, hooks are skipped.
- **Gemini.** [#22521]: cancelling does not always run the cleanup steps.

### 2. Compaction: the original request gets lost

- **Codex [#5957]** (33C/12R, open; checked): after compaction the agent forgets
  it is in the middle of a task and forgets the files it edited.
- **Claude Code [#63601]:** compaction loses the record of the agent's own edits,
  so the model attributes its work to the user.
- **Pi [#6879]:** auto-compaction never triggers until the provider rejects the
  oversized context.
- **Gemini [#3533] and OpenCode [#15533]:** the "compressed" context ends up larger,
  or compaction keeps triggering in a loop.
- **Mitigations seen:**
  - OpenCode's summary contract keeps requirements and exact unresolved requests.
  - Gemini has the model critique its own summaries and rejects summaries that
    came out larger.
  - Pi and OpenCode merge into the previous summary instead of rewriting it.
  - Mistral Vibe re-injects the user's earlier messages.
  - None of these makes compaction lossless.
- **Paper (R7, Obs. 5):**
  - Compact at a fixed margin below the context window.
  - Keep a verbatim recent tail and merge summaries incrementally.
  - Run the same routine reactively on overflow.
  - Persistent memory has overtaken compaction as the frontier.

### 3. Sessions: persistence, resume and who writes

- **Codex [#40934] and Gemini [#27276]:** interrupted tool calls, or malformed
  metadata, make resume fail or hide history that is otherwise valid.
- **t3code [#6097]** (18C; checked): a second backend wrote to the same database
  and executed duplicate work. It recurred after the issue was closed.
- **Codex** has a lock per session writer across processes
  (`rollout/src/writer_lock.rs`).
- **Migrations lose history:**
  - OpenCode [#16885].
  - t3code [#14871] (59C/76R): the migration leaves out checkpoints, approvals and
    live sessions.

### 4. Hooks and extensions

- **Similar protocols behave differently.** Gemini aggregates blocking decisions,
  and invalid JSON counts as "allow". Codex lets stop override block. Matching event
  names does not mean equivalent behavior.
- **Breaking changes:**
  - Pi [#8620]: every global extension broke in 0.84.3.
  - OpenCode [#12222] and its V2 migration: extension data was lost and plugins
    had to be ported.
- **Claude Code:**
  - [#60705]: a Stop-hook directive was used as authorization for actions nobody
    requested.
  - [#91870] (261C, open): users ask for more extensibility.

### 5. Parallel sessions on one repository

- **The market model:** one worktree per session. Orca, herdr, t3code (a local,
  existing or new worktree per thread), the Codex app and Claude Code `--worktree`
  all use it.
- **t3code failures:**
  - [#4356]: new threads silently share the checkout.
  - [#3753]: changing directory does not update which session owns the workspace.
  - Its current handoff serializes, rechecks the binding, and protects rollback
    against cancellation.
- **OpenCode** separates Git worktrees (isolation) from snapshots (recovery). A
  snapshot does not isolate writers that run at the same time.

### 6. Permissions and sandboxing

- **Claude Code [#39523]** (open meta-issue): bypass mode has been broken for
  9 months, with 12+ duplicates.
- **Codex:**
  - [#14936] (56C): approvals are requested again and again.
  - [#51601] (124C): the Windows sandbox fails at startup.
- **OpenCode [#22292] and [#23045]:** configuration precedence, or alternative tool
  paths, bypass the restrictions.
- **Paper:**
  - R9: a developer tool needs three modes plus permission patterns.
  - R10: automated contexts need an OS-level sandbox, reusing what exists.
  - R11: write safety rules as data, and keep a floor beneath full access.
  - Obs. 6: sandboxing is among the most code-expensive capabilities.

### 7. Runtime, budget and platform

- **OpenCode [#8030]** (225C): synthetic messages counted as the user's and used up
  premium requests.
- **OpenCode [#11865] and Gemini [#7700]:** hung subagents and nested retries
  consumed time and money without progress.
- **Pi Windows [#7547]** (87C, open):
  - The tools are bash-only.
  - Git Bash path conversion (`/c/…`) breaks paths.
  - `> /dev/null` leaves a `nul` file behind.
  - Users write their own PowerShell extensions.
- **Pi [#4945]** (82C): the openai-codex connection is unreliable.
- **TUI:**
  - Claude Code: scroll and flicker (#826 354C, #3648 337C, #769 307C).
  - Pi: forced scrolling and row corruption (#5825, #8584), and CPU use in long
    sessions (#7730).

## Requirements for `@tesota/core`, ranked

1. **The settlement gate is mandatory.**
   - What: verification is part of the session lifecycle; it is not a hook that
     can be overridden. A verification failure ends as "incomplete", never as
     "done". The receipt separates evidence from human acceptance.
   - Evidence: §1 (Pi #5886, `emitBoundary`, Codex `stop.rs`, #34866).
2. **The request ledger is immutable.**
   - What: the session keeps the exact request, its later amendments, their origin,
     and the base commit. They are persisted before any tool runs. Compaction never
     replaces them with a summary, and verification reads only the ledger.
   - Evidence: §2.
3. **The lifecycle is explicit and durable.**
   - What: the session has explicit states (running, verifying, interrupted,
     terminal) with run generations. Finalization survives cancellation and quota
     exits, and owned operations are awaited before the run settles.
   - Evidence: §1 (Pi #5886, Gemini #22521, Codex #21160).
4. **Each session has exactly one writer.**
   - What: a lease per session and per store prevents duplicate execution.
   - Evidence: §3 (t3code #6097, Codex `writer_lock`).
5. **The workspace binding is transactional.**
   - What: each session gets its own worktree, or a snapshot outside Git. That
     binding governs execution, diffs, verification and cleanup atomically.
   - Evidence: §5.
6. **Authorization has a single boundary.**
   - What: modes plus rules written as data, plus a floor that full access cannot
     cross. The same check applies to built-in tools, MCP and extensions, and it is
     tested on native Windows.
   - Evidence: §6.
7. **Persistence is versioned and recoverable.**
   - What: interrupted records are reconciled and never invented. Migration
     fixtures must preserve verification evidence.
   - Evidence: §3.
8. **The runtime is bounded and attributable.**
   - What: shared budgets for attempts, time and cost; the origin of each request
     is tracked; extension APIs are versioned and published with conformance tests
     for hooks (Claude/Codex) and Pi's API.
   - Evidence: §4 and §7.
9. **The platform and the TUI are tested from day one.**
   - What: native Windows tools that do not depend on Git Bash paths. The TUI
     shell is tested for scrolling, flicker and long sessions.
   - Evidence: §7.

## Not verified

- Astra could not run its local shell. It used GitHub's read-only connector, at the
  revisions listed above.
- Fixes for closed issues were not checked.
- Reaction counts are a snapshot.

[#5886]: https://github.com/earendil-works/pi/issues/5886
[#6879]: https://github.com/earendil-works/pi/issues/6879
[#7547]: https://github.com/earendil-works/pi/issues/7547
[#4945]: https://github.com/earendil-works/pi/issues/4945
[#8620]: https://github.com/earendil-works/pi/issues/8620
[#5957]: https://github.com/openai/codex/issues/5957
[#34866]: https://github.com/openai/codex/issues/34866
[#21160]: https://github.com/openai/codex/issues/21160
[#40934]: https://github.com/openai/codex/issues/40934
[#14936]: https://github.com/openai/codex/issues/14936
[#51601]: https://github.com/openai/codex/issues/51601
[#22521]: https://github.com/google-gemini/gemini-cli/issues/22521
[#3533]: https://github.com/google-gemini/gemini-cli/issues/3533
[#27276]: https://github.com/google-gemini/gemini-cli/issues/27276
[#7700]: https://github.com/google-gemini/gemini-cli/issues/7700
[#15533]: https://github.com/anomalyco/opencode/issues/15533
[#16885]: https://github.com/anomalyco/opencode/issues/16885
[#12222]: https://github.com/anomalyco/opencode/issues/12222
[#22292]: https://github.com/anomalyco/opencode/issues/22292
[#23045]: https://github.com/anomalyco/opencode/issues/23045
[#8030]: https://github.com/anomalyco/opencode/issues/8030
[#11865]: https://github.com/anomalyco/opencode/issues/11865
[#6097]: https://github.com/pingdotgg/t3code/issues/6097
[#14871]: https://github.com/pingdotgg/t3code/issues/14871
[#4356]: https://github.com/pingdotgg/t3code/issues/4356
[#3753]: https://github.com/pingdotgg/t3code/issues/3753
[#63601]: https://github.com/anthropics/claude-code/issues/63601
[#39523]: https://github.com/anthropics/claude-code/issues/39523
[#60705]: https://github.com/anthropics/claude-code/issues/60705
[#91870]: https://github.com/anthropics/claude-code/issues/91870
