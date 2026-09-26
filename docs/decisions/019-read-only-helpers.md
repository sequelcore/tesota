# 019: Let the working agent start read-only helpers

Status: adopted 2026-09-25 and built; off by default, because the first
evaluation showed no gain for its cost (see Delivery). Evidence is in the
[agent delegation landscape](../references/agent-delegation-landscape.md).

## Context

Tesota's working agent does everything in one conversation. Broad reading,
such as finding every place a rule is enforced before changing it, fills that
conversation with file contents it no longer needs, and it cannot look at
independent questions at the same time. Tesota already starts other agents
around the working agent, the reviewers, refuter and fix validator, but the
agent itself cannot hand anything off.

Every major coding agent now lets its agent start sub-agents. The evidence on
when that helps is narrow: a fresh context for token-heavy reading and
independent questions helps; several agents writing the same change does
not, and Cognition, which argued against multi-agent systems, still keeps
writes single-threaded. Pi's author left sub-agents out of Pi because they
are invisible and pass context poorly. Users of the tools that have them ask
mostly for control: cost they can see, permissions that match the parent's
and never hang, limits on depth and fan-out, timeouts, and a record of what
each one did. Anthropic measured multi-agent research at about 15 times the
tokens of chat, and reports that coding splits into parallel work less than
research does.

## Decision

### 1. A helper answers one question and changes nothing

The working agent gets one new tool, `explore`, taking a self-contained
brief: what to find out and why. Tesota answers it with a helper, a fresh
Pi session that has only the read-only file tools already used by reviewers,
confined to the workspace checkout. A helper has no shell, no network, no
editing and no `explore` of its own, so it never asks the operator anything
and cannot start further helpers. It sees the brief, not the agent's
conversation, and returns a summary that names the files and lines it relied
on and says what it did not find.

The working agent stays the only writer in the workspace.

| | Helper | Reviewer |
| --- | --- | --- |
| Started by | The working agent, during its turn | Tesota, after the work |
| Sees | The agent's brief and the checkout | The requests, the evidence and the checkout |
| Output | Advice to the agent | Findings that decide correction and inform the operator |
| Authority | Read-only file tools in the workspace | The same |

### 2. Helpers are bounded

- At most three run at once; the agent may start more calls, which wait.
- At most eight per turn; further calls return an explanation instead.
- Each has a time limit of five minutes, and stops with its turn when the
  operator presses `Ctrl+C`.
- A helper that fails or times out returns that, never an empty answer
  presented as a finding.
- A helper's summary is cut at a fixed length before the agent reads it.

### 3. Helpers are visible and counted

- Each call shows in the conversation as one tool line with its question;
  while it runs, the helper's own reads and searches stream as that line's
  output, and its answer to the agent states the helper's time and tokens.
- Each helper's full conversation is saved in the workspace's `helpers`
  directory, beside the checkout where the agent's tools cannot reach it, so
  the operator can read what it looked at.
- Helpers use the model chosen for the helper role
  ([decision 020](020-models-by-role.md)); the role is `off` until the
  operator chooses a model, which is the switch that turns helpers on for
  sessions started afterwards.

### 4. The agent is told when to use it

The agent's instructions say to use `explore` when answering needs reading
many files or when independent questions can be looked at in parallel, to
keep small targeted reads for itself, to write each brief so it stands on its
own, and never to use it to change files. Helper summaries are the agent's
material to check, not facts: verification and review of the frozen
candidate are unchanged.

### 5. It is measured before it is on by default

An evaluation compares the agent with and without `explore` on tasks with
known answers that need broad reading of a frozen repository: accuracy,
tokens and time over repeated runs. Helpers are enabled by default only if
accuracy is at least the single agent's, and the operator accepts the
measured token and time multiple; otherwise the tool stays available only
when the operator turns it on.

## Delivery

1. The helper: its prompt, read-only session, time limit, summary limit and
   usage count, tested without a model. `isHelperAnswer` and
   `canStartHelper` in `src/verification/helper-answer.ts` are proved by
   `bun run formal:check`.
2. The `explore` tool on the working agent, with the concurrency and per-turn
   limits, cancellation, streamed activity and saved transcripts.
3. The agent's instructions, and the helper role as the switch.
4. `bun run live:delegation`, the evaluation, and the default decided from
   its results. First measured on 2026-09-25 with GPT-6 Luna as agent and
   helper, two rounds of six questions about this repository at `2cccf074`:
   52 of 52 facts stated with and without helpers, while helpers used 2.4
   times the tokens (1,050k against 430k) and 2.7 times the time (355 s
   against 133 s). The agent asked 11 helpers in 12 attempts and answered
   two questions without any. **Helpers stay off by default.** The set
   measures single questions a lone agent answers easily in a small
   repository; it does not measure long sessions whose context fills, which
   is where helpers are meant to help. Revisit with that evidence from real
   use.

## Consequences

- Broad reading leaves the agent's conversation, at the cost of more tokens
  in total.
- A helper can be wrong; the agent must treat its summary as a lead, and the
  review still judges only the frozen result.
- Helpers never change the workspace, so they add no merge or conflict
  problems, and they need no approval flow.

## Rejected alternatives

- **Helpers that edit, each in its own worktree.** Parallel writers are the
  pattern that fails in every report, and merging their work would need a
  second review of each branch.
- **Helpers with a shell.** Commands would need the operator's approval from
  inside another agent's turn, which other tools found deadlocks or hangs.
- **Named specialist sub-agents.** The evidence supports a fresh context, not
  roles; reviewers already cover judging the result.
- **Only separate sessions, as Pi suggests.** Tesota already lets the
  operator open another session to explore; the question here is whether the
  agent benefits from doing it within its own turn, which the evaluation
  answers.
- **Nesting.** Depth 1 in Codex and Hermes by default; no measured benefit
  deeper.
