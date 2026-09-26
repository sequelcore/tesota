# Models by role landscape (September 2026)

Which model to give each of Tesota's roles when the operator has both a
ChatGPT plan (Codex route) and a Claude plan (Claude Code route): what the
labs publish, what independent benchmarks and papers show about reviewing
with a different model, and what practitioners report. Researched on
2026-09-26 from the sources linked below. GPT-6 Astra was released on
2026-09-03, GPT-6 Sol, GPT-6 Luna and Claude Opus 5.5 on 2026-09-22, so
every comparison here is days old; recheck before relying on it. It informs
the operator's choice in `~/.tesota/models.json`, not a default: Tesota's own
measurements are in [findings](../findings.md).

## The working agent

- **Lab claims conflict, as expected.** OpenAI calls Astra "our best model
  across the board" and places Sol at 68.8% and Luna at 66.6% on DeepSWE, near
  Claude Opus 5 at medium effort
  ([OpenAI](https://openai.com/index/introducing-gpt-6-sol-and-luna/), via
  search; the page refused direct retrieval). Anthropic reports Opus 5.5
  setting the state of the art on Terminal-Bench 4.0 and scoring 54.6% on
  FrontierCode against Astra's 53.3%
  ([Anthropic](https://www.anthropic.com/claude-opus-5-5)).
- **Independent indices put them close.** Artificial Analysis measured Opus
  5.5 at 58 on its Intelligence Index, several points above any other model,
  and level with Astra on Terminal-Bench (59.6%); Astra ties for first on its
  Coding Agent Index at 62. Opus 5.5 produced 1.6 times Opus 5's output tokens
  for the same cost per task
  ([Opus 5.5](https://artificialanalysis.ai/articles/claude-opus-5-5),
  [Astra](https://artificialanalysis.ai/articles/benchmarking-gpt-6-astra)).
- **A practitioner's replay separates care from cost.** On six real merged
  changes in a 3,700-file TypeScript monorepo, 20 runs each, Opus 5.5 never
  broke a passing test and GPT-6 Sol broke one five times; both covered about
  85% of the files the real fix touched. Every regression Sol made failed an
  existing test. Opus produced 495k output tokens against Sol's 192k, and cost
  1.6 times Sol on simple changes and 6.1 times on complex ones. The author's
  advice: Sol where strong tests and review exist, Opus for unattended runs
  ([paddo.dev](https://paddo.dev/blog/opus-5-5-vs-gpt-6-sol), one author).
- **Practitioner consensus** follows the same line: Sol for high-volume work
  with clear pass or fail, Opus 5.5 for ambiguous refactors, architecture and
  long-horizon work where a miss is expensive
  ([Dan Shipper, Every](https://x.com/danshipper/status/2102461471716483208)).

## The reviewer

- **Labs recommend a separate reviewer.** Anthropic's Claude Code guidance:
  "A fresh context improves code review since Claude won't be biased toward
  code it just wrote", with a writer/reviewer pattern of two instances
  ([best practices](https://code.claude.com/docs/en/best-practices)).
- **Self-review is weak and self-preference is real.** Without external
  feedback, models often fail to correct themselves and sometimes get worse
  ([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798)). Evaluators
  recognize and favor their own outputs, and the preference grows with
  self-recognition ([Panickssery et al., NeurIPS 2024](https://arxiv.org/abs/2404.13076)).
  A panel from different families correlated better with human judgement than
  one large judge ([Verga et al., 2024](https://arxiv.org/abs/2404.18796)).
  These studies judge text quality, not code defects. Two 2026 studies,
  checked on 2026-09-26, reach code and families: on LiveCodeBench and
  IFEval, whose criteria are checked by programs, judges "can be more than
  50% more likely to incorrectly mark them as satisfied when the output is
  their own", and ensembles reduce but do not remove it
  ([Pombal et al., 2026](https://arxiv.org/abs/2604.06996)); across four
  open-weight families, judges favored their own family by 3.4 to 8.4
  percentage points in pairwise preference, once candidate quality is held
  fixed ([Awuni et al., 2026-09-15](https://arxiv.org/abs/2609.17857)). The
  family result is on open models and preference judgments, not on the
  labs' current models or on code.
- **Cross-model code review is asymmetric, but the study's reviewer edits.**
  On 116 LiveCodeBench problems, Claude Opus 4.7 reviewing GPT-5.5 drafts
  raised the pass rate from 71.6% to 89.7%; GPT-5.5 reviewing Opus drafts
  lowered it from 91.4% to 82.8%, because the reviewer rewrote programs it was
  unsure of (13 regressions, 3 fixes)
  ([arXiv 2607.21656](https://arxiv.org/abs/2607.21656)). Its reviewer
  produces the final program without running tests; Tesota's reviewer only
  reports findings, which a refuter tests before any reaches the agent, so the
  mechanism does not carry over. It used older models and single-file
  problems.
- **Review benchmarks favor Astra on harder bugs.** CodeRabbit measured Astra
  at 61.3% actionable bug coverage against 59.0% for GPT-5.6 Sol and 50.2%
  for Opus 5, and 57.1% against 47.6% and 42.9% on cross-file reviews, calling
  it "an early, directional result"
  ([CodeRabbit, Astra](https://www.coderabbit.ai/blog/gpt-6-astra-code-review-evaluation)).
  Opus 5.5 caught 8 to 10 of 13 harder cases against the production
  baseline's 5 ([CodeRabbit, Opus 5.5](https://www.coderabbit.ai/blog/opus-5-5-model-review)).
  On 50 pull requests from five projects, Astra found 92 verified bugs at 96%
  precision and GPT-5.6 Luna 69 at 74%, weakest on security and concurrency;
  that is the previous Luna, not GPT-6 Luna
  ([HyperAI](https://hyper.ai/en/stories/61420e1b8b747e0a57a34e18041183d9)).
- **Tesota's own set cannot separate them.** On its eight frozen candidates,
  Luna, Sol, Astra and Claude Sonnet as reviewer all found 4 of 4 defects;
  Astra took about 117k tokens and 118 s per run against Luna's 69k and 69 s.
  The set is easy; the roadmap revisits reviewer models with harder cases.

## Implications for Tesota

1. **The agent is where the plan's limits go.** On the Claude Pro plan, Opus
   5.5 as the agent spends several times Sol's tokens on the same change.
   Tesota's loop supplies what the practitioner found Sol needs, checks and a
   review with correction, and what Opus buys, few regressions, matters most
   on ambiguous refactors and unattended runs.
2. **A reviewer from another family than the agent** follows the labs'
   writer/reviewer advice and the self-preference findings; Tesota's
   read-only reviewer with a refuter avoids the harm the cross-model study
   found when a reviewer rewrites code.
3. **Astra's measured advantage is on harder and cross-file bugs**, which
   Tesota's evaluation set does not contain; its cost shows there instead.
4. **The refuter has only Tesota's own evidence**: Luna once refuted a real
   defect; Sol and Astra did not.
