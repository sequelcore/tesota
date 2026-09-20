# Public positioning evidence

Research cutoff: **2026-09-19**.

This reference records the external evidence behind Tesota's public identity.
It compares current first-party product language and selected verification work.
It does not rank product quality, prove market demand or establish that a product
lacks a capability not emphasized in the inspected material.

## Method and scope

The review inspected public product pages, documentation, repositories, release
notes and research material from the organizations responsible for the selected
work. Vendor claims establish how a vendor describes its product; they do not by
themselves establish comparative effectiveness. Quantitative results retain the
scope and limitations reported by their authors.

The sample includes coding agents, extensible agent harnesses and general-purpose
agents because Tesota's first domain is software development while its long-term
identity is not coding-only.

## Agent categories and market language

| Product | Self-described center of gravity | Positioning implication for Tesota |
| --- | --- | --- |
| [OpenAI Codex](https://openai.com/codex/) | A coding agent and AI coding partner for end-to-end engineering, multiple surfaces, parallel work and background automation | Completing engineering tasks and supporting several surfaces are category expectations, not sufficient differentiation |
| [Claude Code](https://code.claude.com/docs/en/overview) | An agentic coding tool that reads codebases, edits files, runs commands and integrates with development tools | Broad tool use, planning and verification are established coding-agent behavior |
| [Pi](https://github.com/earendil-works/pi) | An agent harness with a self-extensible coding agent plus reusable model, runtime and TUI packages | Pi can supply Tesota's engine mechanics; Tesota needs its own product lifecycle and identity |
| [GitHub Copilot](https://github.com/features/copilot) | AI across the GitHub development workflow with model, agent and organizational controls | Repository integration and enterprise governance belong naturally to GitHub's platform position |
| [Cursor](https://docs.cursor.com/chat/overview) | An editor-centered agent that searches, edits, runs commands and presents diffs | Autonomous editing and diff review are expected interaction features |
| [Cline](https://cline.bot/) | An open coding agent across IDE, terminal and SDK, emphasizing model choice, Plan/Act, extensions and automation | Open, extensible and multi-model is already an occupied position |
| [OpenCode](https://opencode.ai/) | An open-source coding agent spanning terminal, IDE and desktop with broad provider choice | Open source and provider flexibility are attributes, not a complete identity |
| [Aider](https://aider.chat/) | AI pair programming in the terminal with Git, lint and test correction | Terminal use and diagnostic-driven correction already have concise market language |
| [goose](https://block.github.io/goose/) | A local, general-purpose open-source agent with providers, extensions, recipes and subagents | General-purpose reach is possible, but locality and composability alone do not distinguish Tesota |
| [Hermes Agent](https://nousresearch.net/hermes-agent/) | An open-source agent intended for work beyond an IDE or a single coding workflow | Tesota may grow beyond coding, but cannot claim general-purpose capability before demonstrating it |
| [Gemini Code Assist agent mode](https://docs.cloud.google.com/gemini/docs/codeassist/agent-mode) | Multi-step development work with plans, permissions, MCP and contextual tools | Planning and permission prompts are baseline controls rather than a complete product thesis |

Across this sample, products repeatedly emphasize tool use, planning, persistent
sessions, multiple surfaces, model or provider choice, extensibility, parallel
execution and automation. These descriptions do not imply equivalent authority,
isolation, evidence or recovery semantics.

## Experience-first communication pattern

The agent products in this sample generally introduce themselves in the order a
new user evaluates them: what the product is, what work it helps accomplish,
why it differs and how to begin. Implementation mechanics follow later.
Claude Code, Codex, OpenCode, Aider, goose, Hermes and Gemini all lead with work
or experience in their inspected public language. Pi is the relevant exception:
it leads with a harness because the harness is the product it offers.

Tesota uses Pi but is not Pi. Its public documentation should therefore lead
with Tesota as an agent and the experience of working toward a result. Exact
candidate identity, evidence provenance, authority and settlement remain
essential differentiators and technical contracts, but they should not be the
vocabulary a person must learn before trying the product.

## Execution environments and isolation

Current tools expose several execution mechanisms rather than treating one as
the category definition:

- [VS Code agents](https://code.visualstudio.com/docs/agents/run/approvals)
  document approvals and terminal sandboxing as separate controls. Sandbox
  support and enforcement vary by operating system, and elevation remains an
  explicit transition rather than an invisible fallback.
- [Claude Code](https://code.claude.com/docs/en/sandbox-environments) compares
  OS sandboxing, sandbox runtimes, containers, virtual machines and cloud
  environments. Its guidance positions OS sandboxing for everyday local work
  and stronger isolation for unattended or untrusted execution; it does not
  make Docker the only supported model.
- [Gemini CLI](https://geminicli.com/docs/cli/sandbox/) documents platform-
  dependent sandbox providers including Seatbelt, Docker or Podman, Windows
  low-integrity execution, gVisor and LXC. The provider name alone does not
  establish equivalent filesystem, network or credential protection.
- [Codex 0.155.1](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/README.md#windows)
  distinguishes legacy full-read Windows policies from elevated split-filesystem
  policies with exact readable and writable roots. This makes an older failed
  full-read comparison insufficient to judge the current exact-root provider;
  it does not qualify that provider for Tesota.
- [Pi's sandbox extension example](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts)
  demonstrates replacing its normal shell tool with an OS-level Seatbelt or
  bubblewrap boundary. This establishes an extension seam, not a product-wide
  confinement guarantee.
- [Vercel Sandbox](https://vercel.com/docs/sandbox) uses remote Firecracker
  microVMs for untrusted code and agent workloads. That is a relevant future
  execution environment, but it adds remote identity, credential, lifecycle and
  infrastructure ownership that Tesota does not currently need.

The supported market inference is narrow: low-friction local execution and
stronger isolated execution can coexist behind explicit policy. The mechanisms
are not interchangeable, and approval is not confinement. Tesota's architectural
decision is recorded in
[decision 007](../decisions/007-execution-environments.md).

Container use also converges on reusable environments rather than rebuilding a
private dependency universe for every command. Gemini mounts the workspace into
its Docker or Podman sandbox and describes startup overhead as small after the
initial build. The open [Development Container Specification](https://containers.dev/)
exists so local tools, cloud environments and CI can reuse a development
definition, while [OCI](https://opencontainers.org/) standardizes container
images, runtimes and distribution independently of Docker.

These sources and public issue reports are not a representative community
survey. They support only a directional inference: users benefit from low setup
friction, fast repeated feedback, reuse of repository-owned environments,
cross-platform choices and explicit protection differences. They do not
establish one universally preferred provider or a measured ranking of demand.

## Why verification is becoming central

Several independent source families point toward verification as a first-class
agent interface:

- [Vercel's engineering guidance](https://vercel.com/blog/agent-responsibly)
  argues that convincing agent output and green CI do not establish production
  safety. It recommends closed-loop systems, continuous validation and executable
  guardrails while retaining human ownership of shipped work.
- [`@shadcn/lint`](https://github.com/shadcn-ui/lint) turns design-system policy
  into executable, agent-oriented diagnostics. Its
  [published evaluations](https://github.com/shadcn-ui/lint/blob/main/docs/evals.md)
  report that diagnostic feedback improved convergence and correction cost in
  specific paired runs. The authors also report escapes, same-family evaluation,
  added correction work and no improvement to first drafts; these results are not
  a universal effectiveness claim.
- [Microsoft Research's Interwhen](https://www.microsoft.com/en-us/research/video/introducing-interwhen-steering-reasoning-agents-with-real-time-verification/)
  treats intermediate agent actions as verification subjects and composes
  plug-in symbolic or model-based verifiers. Its benchmark claims are
  author-reported research results, not independently reproduced Tesota evidence.
- [Microsoft's production verification work](https://www.microsoft.com/en-us/research/blog/verifying-rust-cryptography-in-symcrypt-from-standards-to-code/)
  separates stochastic proof generation from deterministic proof checking: an
  agent may propose a proof, while Lean independently validates it. This supports
  the separation principle, not the use of formal verification for every task.
- [Dafny](https://dafny.org/) demonstrates the established model of checking an
  implementation against explicit specifications. Its
  [AI-assisted verification work](https://dafny.org/blog/2025/06/21/dafny-annotator/)
  explores using models to produce proof annotations that remain subject to the
  verifier.
- [Gentle AI 2.8.0](https://github.com/Gentleman-Programming/gentle-ai/releases/tag/v2.8.0)
  emphasizes candidate identity, explicit review authority, truthful recovery,
  terminal outcomes and inspectable runtime state. This is provider evidence
  about its own contract and release, not proof of Tesota's complete lifecycle.

The supported inference is narrower than "verification solves AI reliability."
Agent output is probabilistic, increasingly consequential and cheap to produce;
executable checks can provide independent, actionable observations about some
properties of that output. No inspected source establishes that one verifier,
green CI or model review can prove an entire real-world task correct.

## Tesota's position

Tesota's canonical category is:

> **An open-source, verification-first agent.**

Its thesis is:

> AI makes production abundant. Evidence remains scarce.

Tesota makes the relationship between intent, admitted work, the produced
result, applicable evidence, correction and adoption its organizing principle.
Software development is the first proving ground because repositories provide
useful existing verifiers and concrete candidate boundaries. It is not the
permanent limit of the identity.

This is a difference of product focus, not an assertion that other agents lack
tests, sandboxes, approvals, review or evidence. The position is defensible only
if Tesota's implementation and demonstrations preserve the claimed relationship.

## Claim boundaries

Current repository evidence supports describing Tesota as:

- an Apache-2.0 open-source project prepared for public development;
- a verification-first agent by intended lifecycle;
- local and terminal-first in its current implementation;
- pre-release and intentionally narrow;
- initially focused on bounded software-development tasks;
- built around distinct task, candidate, evidence, review, acceptance and
  adoption ownership.

Current evidence does not support describing it as:

- a demonstrated general-purpose agent;
- safer, more reliable or more productive than another product;
- ready for arbitrary repositories or untrusted workloads;
- model-independent in currently qualified operation;
- a replacement for an editor, CI platform or established agent;
- proven to reduce defects, cost or operator time across representative work.

## Validation still required

Positioning remains a product hypothesis until intended users recognize the
problem and prefer the resulting experience. Software-development trials should
measure accepted outcomes, residual defects, active operator work, correction
cost, elapsed time and unsupported cases. Any later domain needs its own
candidate definition, applicable verifiers, effect boundaries and adoption
evidence.

The product name also needs professional trademark, domain and social-handle
clearance. A general web search cannot establish legal availability.
