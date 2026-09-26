# Reasoning levels landscape (September 2026)

What the labs document about reasoning effort, what is measured about it for
coding and review, and what it implies for choosing a level per role in
Tesota. Researched on 2026-09-26 from the sources linked below and Pi 0.87.1's
catalogue; it informs decision 029. Recheck product behavior before relying
on it.

## What the engines accept

| | Levels | Default | Where |
| --- | --- | --- | --- |
| OpenAI ([reasoning guide](https://developers.openai.com/api/docs/guides/reasoning)) | Model-dependent among `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; GPT-6 Astra has no `none` | `medium` for GPT-6 Sol and Luna | `reasoning.effort` |
| Anthropic ([effort](https://platform.claude.com/docs/en/build-with-claude/effort)) | `low`, `medium`, `high`, `xhigh`, `max`, model-dependent; Haiku 4.5 is not listed as supporting effort | `high`, except **Claude Opus 5.5, which defaults to `medium`** | `output_config.effort`; the Claude Agent SDK's `effort` option |
| Pi (`getSupportedThinkingLevels`) | Per model: Astra `minimal` to `max`; Sol and Luna `off` to `max`; Opus 5.5 `low` to `max`; Haiku 4.5 `off` to `high` | Tesota sets `medium` for every role today | `thinkingLevel`; an unsupported level is silently clamped |

## What the labs recommend

- **OpenAI:** high effort for "agentic coding, long-horizon research, and
  knowledge work"; extra-high for "security and code review, enterprise
  productivity, deeper research tasks"; and effort is "a tuning knob, not the
  primary way to recover quality".
- **Anthropic:** on Opus 5.5, "Run an effort sweep on your own evals rather
  than carrying settings over from an earlier model"; test the use case, and
  use `low` for simple work such as subagents. For Opus 4.7, `max` "adds
  significant cost for relatively small quality gains, and on some
  structured-output or less intelligence-sensitive tasks it can lead to
  overthinking." Lower effort also means fewer and terser tool calls.

## What is measured

- **General intelligence, not review.** Artificial Analysis' index scores
  GPT-6 Astra 49 at `low`, 52 at `medium`, 53 at `high`, 54 at `xhigh` and 55
  at `max`, at $0.63 to $2.57 per task, as reported by
  [a practitioner's write-up](https://ilikekillnerds.com/2026/09/06/gpt-5-6-sol-to-gpt-6-astra-reasoning-effort/)
  (secondary; the index was not checked at the source). Medium to high is one
  point for about 22% more cost.
- **One anecdote cuts the other way:** in a case study that write-up cites,
  Astra at `high` took longer, cost more and missed a bug that `medium`
  caught. One task, not evidence.
- **Review benchmarks do not state their level.** CodeRabbit's Astra
  evaluation, the strongest review result in the
  [models by role landscape](model-roles-landscape.md), does not say which
  effort it used.

No measurement found compares effort levels on code review.

## Implications for Tesota

1. **Let each role have its own level**, since the labs recommend different
   levels for agentic coding, review and subagent-like work, and both engines
   accept one per session.
2. **Refuse a level a model does not support**, rather than let Pi clamp it
   silently: the operator should know which level a role runs at.
3. **Keep today's behavior when no level is chosen:** Pi at `medium`, and
   Claude Code at its model's default, which for Opus 5.5 is `medium`.
4. **Record the level with each review's models**, so forecasts compare like
   with like, and **measure before changing a default**: the vendor advice
   for review is `xhigh`, but nothing measured shows it finds more on
   Tesota's work, and higher levels cost the plan's limits.
