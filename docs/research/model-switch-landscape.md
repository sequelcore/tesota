# Model switch landscape (September 2026)

How coding agents let the operator change a conversation's model, and what
happens to the conversation when the new model runs on another engine.
Researched on 2026-09-26 from the sources linked below and Pi 0.87.1's source;
it informs decision 026. Recheck product behavior before relying on it.

## What harnesses do

| Harness | Same engine | Another engine or provider |
| --- | --- | --- |
| Claude Code, Codex, Pi | `/model` changes the model and the conversation continues | Not applicable to Claude Code and Codex, which have one provider each. Pi keeps one transcript across providers |
| Amp ([Handoff](https://ampcode.com/news/handoff); [Tessl's report](https://tessl.io/blog/amp-retires-compaction-for-a-cleaner-handoff-in-the-coding-agent-context-race)) | Not the point of the feature | Handoff replaced compaction: the operator states a goal, Amp writes a prompt and a list of relevant files for a **new thread**, and shows the prompt as a draft to review and edit before sending. The aim is focused threads rather than summaries stacked on summaries |
| t3code ([PR #3799](https://github.com/pingdotgg/t3code/pull/3799), closed 2026-07-30 in favor of its orchestration V2) | Continues the provider session | Starts a fresh session on the new provider, replays the earlier messages and a trail of tool calls, commands and edits into its first turn, capped at 80,000 characters with older history silently dropped, and shows "Switched from X to Y" |
| t3code ([issue #4766](https://github.com/pingdotgg/t3code/issues/4766), 2026-07-28) | | A switch made while no session ran started a blank provider session: "The reset is silent and the UI still displays the old conversation, so the user cannot tell that approvals, architectural decisions, constraints, and prior tool results are absent from the model's context." |
| Hermes Agent ([sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions)) | | Its `/handoff` moves the **same** session from the CLI to a messaging channel; it is not a model switch |
| Kiln (`kiln-legacy-2026-09`, `docs/architecture/context/`) | | Summaries and memory are "non-authoritative historical or retrieved material" (`agent-context.md`); "cached continuity is non-authoritative", and task, approval and execution state "must be re-read from canonical tools" (`context-governance.md`) |

## Engines, as Tesota uses them

- **Pi** keeps one transcript whatever the provider. `AgentSession.setModel()`
  switches the model and records the change in the transcript; before each
  call, `transformMessages` adapts the earlier messages to the new model:
  another model's thinking becomes text, signatures that only its own model
  can read are dropped, and tool call ids are normalized. So `codex` and
  `anthropic` models can follow one another in one conversation.
- **Claude Code** takes the model per query, and a query can resume a saved
  conversation, as its own `/model` does in the middle of one.
- **Between the two** no transcript carries over: Claude Code cannot read
  Pi's, nor Pi Claude Code's. The new engine starts a new conversation.

## The prompt cache

Checked on 2026-09-26. Both labs discount cached input heavily: OpenAI bills
it at 0.1 of fresh input for GPT-5.6 and later, and keeps a prefix 30 minutes
([prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching));
Anthropic bills a cache hit at 0.1 of fresh input, 0.05 on Opus 5.5, and a
five-minute write at 1.25
([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
OpenAI lists the model and `reasoning.effort` among what breaks cache reuse,
with one exception on GPT-6 models, a `configuration_update` input item that
changes effort and keeps the prefix; Anthropic states that changing effort
"always invalidates message blocks". Practitioners warn that switching to a
cheaper model mid-conversation can cost more for this reason, and suggest a
handoff document instead.

Measured through Tesota on both engines, a conversation warmed at one model
and level, then continued:

| Engine | Same model and level | After a level change | After a model change | The turn after |
| --- | --- | --- | --- | --- |
| Pi, `codex:gpt-6-luna` to `@high` to `codex:gpt-6-sol` | 1,536 of 2,334 input read from cache | 0 | 0 | cache read again |
| Pi, `codex:gpt-6-astra` to `@high` | 2,176 of 2,336 | 0: Pi does not send the `configuration_update` item | 0 | cache read again |
| Claude Code, Sonnet 5 high to medium to Opus 5.5, per API call | cached from the second resumed turn | 0, 3,783 written | 0, 3,722 written | 3,783 and 3,722 read |

So a switch of model or level costs one turn that reads the whole
conversation at the uncached rate, on both engines; the first resumed turn on
Claude Code also missed the cache once with nothing changed.

## Conclusions for Tesota

1. Switch in place whenever the engine stays the same; the conversation is
   the most faithful context there is.
2. Across engines, start a new conversation and say so. The t3code bug shows
   the failure to avoid: a blank session behind an old-looking transcript.
   A switch made while no agent runs must still be known to change engines,
   so a session has to record the model its conversation runs on.
3. Carry context from Tesota's own records, not from a model's summary:
   the operator's requests verbatim, the pending changes, the open findings
   and the agent's last reply. They cannot be invented, only incomplete,
   which the new agent is told. A replayed transcript, as in t3code, is
   larger and was cut silently at its cap.
4. Say what an in-place switch costs before and after it is made: the
   conversation's size, re-read once without cache, and `/handoff` as the
   cheaper fresh start, since a short brief costs little uncached.
5. Keep the operator's request record the operator's own: context Tesota
   sends is marked as Tesota's, as correction rounds already are. Amp lets the
   operator edit a generated prompt because a model wrote it; Tesota's brief
   is copied from records, is shown whole before it is sent, and the
   operator's next request can correct it.
