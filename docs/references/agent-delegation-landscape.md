# Agent delegation landscape (September 2026)

How current agents let a working agent hand parts of its task to sub-agents,
what studies say about when that helps, and what it implies for a harness
that owns authority, evidence and acceptance. Researched on 2026-09-25 from
the source of cloned projects, vendor documentation and three studies. It
informs a future Tesota decision; no decision is recorded yet. Product
behavior changes quickly; recheck a claim before relying on it.

## What each system does

| System | How the agent delegates | Context and result | Authority and isolation | Limits |
| --- | --- | --- | --- | --- |
| Claude Code ([sub-agents](https://code.claude.com/docs/en/sub-agents), read 2026-09-25) | An `Agent` tool; named sub-agents with their own prompt, tools and model; foreground or background | Fresh context without the conversation, except forks; "returns only the summary" | Inherits the main permission mode unless the definition overrides it; tools filtered per sub-agent, background ones get a smaller set; optional `isolation: worktree` gives a temporary Git worktree | Nesting up to 3 levels by default; up to 20 concurrent. Advises the main conversation for back-and-forth, shared context, small changes or when latency matters |
| Codex (`codex-rs/core/src/agent`, commit `c98e263f`) | Opt-in `[agents]` tools: `spawn_agent`, `send_input`, `wait`, `close_agent`, `resume_agent`, `list_agents` and messaging; configurable roles | Fresh or full-history fork | A child takes the parent turn's approval policy, working directory and permission profile (`apply_spawn_agent_runtime_overrides`); it shares the workspace and the token budget | 6 concurrent threads per session and nesting depth 1 by default |
| opencode (`packages/web/src/content/docs/agents.mdx`, commit `3016830e`) | Primary agents the user switches between, and sub-agents started through a `task` tool or an `@` mention | Each sub-agent is a child session the user can open | `permission.task` decides which sub-agents an agent may start; built-in `explore` and `scout` are read-only, `general` can write | Per-agent `steps` limit |
| Gentle AI (`docs/trigger-rules.md`, commit `8b52c465`) | Uses each host's native sub-agents under explicit routing rules | "Delegates only the actions that benefit from fresh context" | Keeps work inline when it needs 1 to 3 files; delegates narrow exploration and "one writer" when it needs 4 or more files or edits 2 or more non-trivial files; warns against "parallel writers in one worktree" | Rules, not a runtime |
| Hermes Agent (`tools/delegate_tool.py`, commit `2a0d0bc6`) | `delegate_task`, single or batch | Fresh conversation; the parent sees only the call and the summary | Children lose `delegate_task`, `clarify`, `memory`, `send_message` and `cronjob`. An approval prompt from a worker thread deadlocks the terminal, so dangerous commands in children are auto-denied unless configured otherwise | 3 concurrent children; depth 1 unless raised |
| Pi (`examples/extensions/subagent`, commit `96724621`) | An example extension, not core: single, parallel and chain modes | Each sub-agent is a separate `pi` process | Project-local agent definitions are repository-controlled prompts, flagged as a security concern | 8 parallel tasks, 4 at once |
| t3code (`apps/server/src/orchestration/ThreadBackgroundLiveness.ts`, commit `9c7622da`) | None of its own; shows the provider's sub-agents | One timeline row per sub-agent; a sidebar status for background "subagent fleets" | Not applicable | Not applicable |
| Kiln (Sequel `infra/docs/strategy/multi-agent-evaluation.md`, 2026-06-26) | An orchestrator session delegating to Claude sub-agents and to Codex and OpenCode as subprocess workers | Not measured | Workers ran as full-auto subprocesses outside Kiln's safety pipeline | Its evaluation log has no recorded observations |

## Studies and field reports

- **Anthropic, multi-agent research system** ([2025-06-13](https://www.anthropic.com/engineering/multi-agent-research-system)):
  an Opus lead with Sonnet sub-agents beat a single Opus agent by 90.2% on an
  internal research evaluation. Agents use about 4 times the tokens of chat
  and multi-agent systems about 15 times; token usage alone explained 80% of
  the performance variance on BrowseComp. "Most coding tasks involve fewer
  truly parallelizable tasks than research." Early versions spawned 50
  sub-agents for simple queries, and vague delegation led to duplicated work
  and gaps.
- **Cognition, "Don't Build Multi-Agents"** ([2025-06-12](https://cognition.com/blog/dont-build-multi-agents)):
  "Share context", and "actions carry implicit decisions, and conflicting
  decisions carry bad results"; parallel sub-agents building parts of one
  game produced parts that did not fit. **Updated** in
  ["Multi-Agents: What's Actually Working"](https://cognition.com/blog/multi-agents-working)
  (2026-04-22): what works is several agents contributing intelligence "while
  writes stay single-threaded": a review agent (averaging 2 bugs per pull
  request, about 58% severe), consulting a stronger model, and a manager that
  splits work among child agents. Unstructured swarms are "mostly a
  distraction", and the original observations "still hold today for
  parallel-writer swarms".
- **Cemri et al., "Why Do Multi-Agent LLM Systems Fail?"** ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657),
  v3 2025-10-26): 1,600+ annotated traces from 7 frameworks; 14 failure modes
  in three groups (system design, inter-agent misalignment, task
  verification); gains on popular benchmarks "are often minimal".
- **Kim et al., "Towards a Science of Scaling Agent Systems"** ([arXiv 2512.08296](https://arxiv.org/abs/2512.08296),
  v3 2026-04-08): 260 configurations over six benchmarks and five
  architectures. Coordination gained 80.8% on decomposable financial reasoning
  and lost 70.0% on sequential planning; tool-heavy tasks pay
  disproportionately for coordination, and gains shrink once a single agent
  is already strong. A predictive model chose the best architecture for 87% of
  held-out configurations.

## Patterns

1. **Delegation buys a fresh context, not more intelligence.** Every system
   returns a summary to a parent whose context stays small; the benefit is
   largest for broad reading and research, and the cost is tokens.
2. **Writes stay single-threaded.** Cognition, Gentle AI's "one writer" and
   Claude Code's worktree option all avoid several agents editing one tree;
   parallel writers conflict on implicit decisions.
3. **Children never exceed the parent's authority.** Codex copies the
   parent's policy; Claude Code and opencode narrow tools per sub-agent;
   Hermes strips interaction and side-effect tools.
4. **Interactive approval does not reach a child well.** Hermes found a
   deadlock and auto-denies; Claude Code relays background prompts to the main
   session. A supervised harness must route a child's question to the
   operator or keep the child read-only.
5. **Depth and fan-out are capped by default:** depth 1 in Codex and Hermes,
   3 in Claude Code; 3 to 20 concurrent children.
6. **Coding benefits less than research.** Sequential, tool-heavy work loses
   under coordination; decomposable reading gains.

## What it implies for Tesota

Inferences for a future decision, not measured results:

- Tesota already runs agents around the working agent: reviewers, the
  refuter and the fix validator, started by Tesota with read-only tools. That
  is the review pattern Cognition reports as working. Working-agent delegation
  is a different feature: the agent choosing to start helpers during its turn.
- The first useful form is read-only: helpers that explore the repository or
  research and return a summary, while the working agent stays the only
  writer in the workspace.
- A helper's authority must not exceed the agent's: the same workspace
  confinement and environment, fewer tools, no delegation of its own. In a
  supervised session a helper's command either reaches the operator through
  the existing question path or is not available.
- Helpers' results are advice to the agent, not evidence; verification and
  review of the frozen candidate stay as they are.
- Their tokens and time belong in the same measurements as the rest of the
  step, and the operator should see each helper's activity.
- Whether delegation improves Tesota's results on repository tasks is not
  known; it needs an evaluation against the single agent before adoption, as
  decision 016's rule requires.

## Coverage and limits

Clones of opencode (2026-08-03), Hermes (2026-08-07) and t3code (2026-08-10)
are older than Codex and Gentle AI (2026-09-25); their current behavior may
differ. Kiln's own source was not inspected, only its evaluation document.
Cursor, Gemini CLI and Qwen Code sub-agents were not examined. The studies
measure research, planning and benchmark tasks, not coding in a harness like
Tesota's.
