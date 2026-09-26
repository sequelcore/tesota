# Public evaluation landscape (September 2026)

Which public benchmarks can measure Tesota instead of, or beside, its own
evaluation cases, and what they measure. Researched on 2026-09-26 from the
benchmarks' papers, repositories and datasets linked below. It informs
decision 023.

## Why Tesota's own cases are not enough

`bun run live:review` runs eight candidates written for Tesota by the same
hands that wrote its prompts and its scoring, and several review changes were
tuned against them. Every reviewer model measured on them, from GPT-6 Luna to
GPT-6 Astra and Claude Sonnet, found all four planted defects, so the set no
longer separates models. It remains a regression check of Tesota's machinery:
origin checking, refutation, duplicate merging and correction.

## Benchmarks

| Benchmark | Measures | Ground truth | Fit |
| --- | --- | --- | --- |
| [SWE-PRBench](https://arxiv.org/abs/2603.26130) (2026-03-27) | Review of 350 real pull requests; the paper's split is 100 PRs, stratified by difficulty | Human reviewers' own comments on the merged PRs; a fixed GPT-5.2 judge classifies each AI comment, validated at κ = 0.75 | Tesota's review step, the part it claims most; frontier models caught 15 to 31% of human-flagged issues with the diff alone, so it separates models where Tesota's cases do not |
| [Terminal-Bench](https://github.com/harbor-framework/terminal-bench) through [Harbor](https://github.com/harbor-framework/harbor) | Whole agents on hard command-line tasks | Tests per task | Tesota as a harness against plain Pi with the same model; Harbor takes an agent adapter, and Pi's author publishes [one for Pi](https://github.com/badlogic/pi-terminal-bench). Needs a way to run Tesota without its interactive shell |
| [SWE-bench Pro](https://www.morphllm.com/swe-bench-pro) (Scale AI) | 1,865 tasks in 41 repositories | Tests per task | As Terminal-Bench, at a larger environment cost |
| SWE-bench Verified | — | — | Not used: OpenAI stopped reporting it in February 2026 after finding flawed tests and memorized solutions ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)) |

## SWE-PRBench in detail

- **Released under open licenses**: the dataset under CC BY 4.0 on
  [Hugging Face](https://huggingface.co/datasets/foundry-ai/swe-prbench) and
  the harness under MIT on
  [GitHub](https://github.com/FoundryHQ-AI/swe-prbench), pipeline version
  v0.4.1 at commit `379f0bf`. Python is 69% of the PRs, then JavaScript, Go,
  TypeScript and Java.
- **Protocol**: an agent receives a frozen context per PR (`config_A`, about
  2,000 tokens: task and focus, key changes, the diff and metadata; `B` and
  `C` add execution context and test signatures) and returns a JSON array of
  `{body, file, line, severity}` with P0 to P2 severities. The judge labels
  each comment confirmed, plausible or fabricated; comments are matched to
  human ones by embeddings with bipartite matching; a weighted composite
  combines recall, precision, alignment and actionability, minus
  hallucination, redundancy and excess plausible comments, weighted by
  difficulty.
- **Published scores** on the 100-PR split with the GPT-5.2 judge: Claude
  Sonnet 4.6 leads at 0.153; every model degraded as context grew from A to C.
- **Limits**: the paper evaluates single model calls at temperature 0 and
  gives no protocol for agents with tools; human comments are one reviewer
  team's view of each PR, and plausible issues they did not raise count
  against precision.

## What this means for Tesota

The harness always calls its own agents, so Tesota's reviews enter it the way
SWE-bench predictions do: Tesota answers each PR's official context with the
official answer format, and the harness's own parser, judge, scorer and
report code run unchanged on those answers. Tesota's reviewer receives only
what the benchmark's agents receive, the `config_A` context, without the
repository, so its score is comparable to the published ones; that makes it
a measure of Tesota's review prompt, lenses and refuter, not of reading the
whole repository.
