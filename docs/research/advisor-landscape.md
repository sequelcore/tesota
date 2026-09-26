# Advisor landscape (September 2026)

How coding agents let a working model consult a stronger one mid-task, what
is measured about it, and what it implies for Tesota's advisor. Researched on
2026-09-26 from the sources linked below; it informs decision 027. Recheck
product behavior before relying on it.

## What systems do

| System | Advisor | What it sees | Tools | When it is called |
| --- | --- | --- | --- | --- |
| Anthropic's advisor tool ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool), beta `advisor-tool-2026-03-01`, launched 2026-04-09) | An Opus or Fable model advising an Opus, Sonnet or Haiku executor, server-side in one API request | "the executor's full transcript as quoted context": the system prompt, tool definitions, prior turns and tool results, and the text of the current turn. The call's input is always empty: "The executor signals timing, and the server supplies context" | None: "The advisor itself runs without tools", and its thinking is dropped; only the advice text returns | The executor decides. Recommended: early, "after a few exploratory reads", before writing or committing to an approach; when stuck or changing approach; once more before declaring done. `max_uses` caps calls per request |
| Amp's Oracle ([tools](https://ampcode.com/docs/tools), [announcement](https://ampcode.com/news/gpt-5-oracle), 2025-10-01) | A "second opinion" model, deliberately from **another lab** than the main agent: GPT-5 was chosen for "its different training lineage", and the current routes pair Claude with GPT models | Not stated in the pages read | Not stated in the pages read; it "runs with extra-high reasoning" | "The main agent can autonomously decide to ask the oracle" when debugging or reviewing; not forced, "due to higher costs and slower inference speed"; users ask for it explicitly |
| Cognition ([Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working), 2026-04-22) | "Consulting a stronger model" is one of the three multi-agent patterns it reports as working | | | Writes stay with one agent |

## What is measured

All from Anthropic, on its own models; vendor results, not independent:

- Sonnet with an Opus advisor: 74.8% on SWE-bench Multilingual against 72.1%
  alone, at 11.9% lower cost per task; better Terminal-Bench 2.0 scores at
  lower cost ([the advisor strategy](https://claude.com/blog/the-advisor-strategy)).
- Haiku with an Opus advisor: 41.2% on BrowseComp against 19.7% alone.
- The benefit "shrinks as the executor's own capability approaches the
  advisor's"; "Results are task-dependent. Evaluate on your own workload."
- Advice is typically 400 to 700 text tokens, billed at the advisor's rates.
  Asking the advisor directly for brevity ("please keep your guidance under
  80 words") lowered total cost even though consults became more frequent.
- Executors under-call it on coding without prompting. Anthropic's suggested
  timing block raised consistency; a harder rule (consult before the first
  write) helped under-calling Opus by 7 to 10 points on those tasks but was
  "roughly flat on a mixed workload", and Anthropic advises against it as a
  default. A reminder after the first turn helped Haiku, did nothing for
  Sonnet and slightly hurt Opus.
- How the executor treats advice matters: give it weight, adapt when a step
  fails empirically or primary evidence contradicts it, and when evidence and
  advice disagree, "don't silently switch": ask the advisor once more with
  the conflict.

## What it implies for Tesota

1. **Follow the measured shape:** the advisor reads the agent's conversation
   and has no tools. Nothing it reads can make it act, and it cannot change
   the workspace, so the agent stays the only writer.
2. **Build it into Tesota, not the provider.** Anthropic's tool is a
   server-side feature of its API; Tesota's agent runs on Pi or Claude Code
   through the operator's plans. Tesota can give the advisor the
   conversation itself: Pi holds its messages, and Claude Code's are
   observed as they stream and readable afterwards through the SDK. Any route
   can then advise any other, which also allows Amp's cross-lab pairing.
3. **Let the agent choose the timing,** with Anthropic's suggested timing
   and advice-handling guidance in the system prompt, not the harder rule.
   Let the agent add a focused question: a reconcile call ("I found X, you
   suggest Y") needs one.
4. **Cap consults per request, and show each one** with its time and tokens,
   as explorers are shown.
5. **Advice is advice.** It never enters review evidence; checks and
   reviewers still judge the frozen candidate.
6. **Off by default**, like explorers: whether it helps Tesota's own tasks is
   not measured, and the benefit depends on the gap between the two models.
