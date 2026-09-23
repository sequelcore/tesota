# Verifier strategy

This document owns verifier selection and qualification criteria. It does not
set current product priority; the [roadmap](roadmap.md) does. Research
candidates become implementation work only when observed tasks justify them.

The [product identity](identity.md) defines why Tesota is verification-first.
This document turns that thesis into selection and qualification criteria for
executable verifiers. In the initial software-development domain, a trusted
owner selects an applicable check, Tesota runs it within an explicit effect
boundary, the agent receives bounded diagnostics, and a corrected candidate is
checked again. Evidence informs assessment; it never grants acceptance or
adoption authority.

This document owns the criteria and research candidates for expanding Tesota's
verifier portfolio. It does not declare unimplemented integrations. The
[verification contract](verification.md) and [architecture](architecture.md)
own implemented behavior; the [roadmap](roadmap.md) owns status and priority.

## Evidence portfolio

No verifier establishes an entire task. Tesota therefore needs complementary
evidence selected for the claims and effects of the work, not a universal
verifier interface that erases tool-specific meaning.

Tesota should therefore optimize for a portfolio of complementary evidence:

| Evidence class | Question it can answer | Representative current or researched tools |
| --- | --- | --- |
| Syntax and local static rules | Does this source violate a selected mechanical rule? | Oxlint, Ruff, Clippy |
| Types and compilation | Is the program accepted under the repository's language and build contract? | TypeScript, Rust/Cargo |
| Repository behavior | Does the candidate satisfy an executable example or integration contract? | Vitest and repository-owned checks |
| UI system policy | Does generated UI use the components, variants and theme as allowed? | `@shadcn/lint` |
| Security policy | Does static analysis find a selected unsafe pattern or data-flow violation? | Semgrep, CodeQL-compatible SARIF producers |
| Runtime behavior and accessibility | Does the built application exhibit the checked browser behavior and machine-detectable accessibility properties? | Playwright, axe-core |
| Generalized properties | Does the implementation hold over generated cases or an explicit formal specification? | fast-check, LemmaScript/Dafny |
| Review evidence | Does an independent, identity-bound review find an integration or reasoning defect? | Gentle AI |
| Dependency state | Do resolved dependencies match currently known vulnerability records? | OSV-Scanner |

No row subsumes the others. A clean lint result cannot establish behavior, a
passing test cannot establish an unstated property, a formal proof cannot cover
an incorrect specification, and a review verdict is not delivery authority.

## What native means

A verifier becomes **native to Tesota** when Tesota owns and tests its complete
integration contract. Native does not mean vendoring every tool, copying its
rule engine, or accepting arbitrary commands from model text. The tool may
remain an external repository dependency.

A native integration must define:

1. **Selection and scope.** Trusted application or repository configuration
   selects the verifier, configuration, inputs and allowed effects. Agent output
   cannot expand them.
2. **Observed identity.** Evidence records the executable or package identity,
   version, material configuration and other inputs needed to decide whether a
   result still applies.
3. **Bounded execution.** Time, output, filesystem, environment, process and
   network effects are explicit. An interrupted or unconfirmed process cannot
   report a completed check.
4. **Validated results.** Tesota distinguishes findings from parse, setup,
   infrastructure, timeout and incomplete-execution failures. An empty or
   malformed report is not a pass.
5. **Actionable diagnostics.** The agent receives the smallest safe projection
   that identifies the violated contract and supports correction. Canonical
   evidence stays with Tesota.
6. **Candidate binding.** The result is bound to the exact candidate inputs and
   becomes stale when relevant source, configuration, dependencies or verifier
   identity changes.
7. **Reverification.** A correction is checked again under the same applicable
   contract. Prior passing evidence never transfers to changed bytes by
   implication.
8. **Authority separation.** Check evidence, provider review, human acceptance
   and promotion remain different states and owners.
9. **Lifecycle support.** Upgrade, cancellation, recovery, retention and removal
   behavior are tested. Unsupported states fail closed and legacy compatibility
   is not added without an active consumer.

Tesota should implement a dedicated adapter for the first instance of a result
contract. Shared abstractions are justified only after at least two implemented
consumers expose the same stable semantics. This preserves one owner per
behavior and avoids designing a universal verifier framework in advance.

## Qualification standard

Popularity, a launch announcement and a vendor benchmark can nominate a tool;
they cannot qualify it. Tesota evaluates a candidate against all of the following
criteria:

| Criterion | Required evidence |
| --- | --- |
| Relevant defect detection | Seeded and naturally occurring defects from a supported task class are detected with acceptable false-positive cost |
| Correction value | Diagnostics let the selected agent reach a correct recheck without hidden operator repair |
| Result integrity | Success, findings, operational failure, partial output and timeout can be distinguished and adversarially tested |
| Bindability | Source, configuration, dependency and tool identity can be captured or the missing dimension is reported explicitly |
| Controllability | The invocation fits Tesota's admitted scope and isolation policy; implicit network, plugin, build-script and descendant effects are known |
| Repeatability | Pinned fixtures reproduce the expected result, or environmental variability is recorded as part of applicability |
| Cost | Wall time, model tokens, correction rounds and operator intervention are measured against the same task without the candidate verifier |
| Maintenance | Versioning, platform support, licensing and upgrade behavior are compatible with a maintained adapter |

Evidence advances through five levels:

1. **Documented:** primary documentation establishes the claimed interface.
2. **Compatible:** a pinned local fixture proves invocation and result parsing.
3. **Corrective:** a seeded failure is returned to the agent, corrected and
   rechecked without weakening the oracle.
4. **Useful:** real tasks in at least two repositories show lower residual defect
   or intervention cost than the declared control.
5. **Native:** the bounded adapter, evidence binding, failure paths, regression
   tests and upgrade procedure are maintained as a Tesota contract.

Only levels 4 and 5 justify a claim of demonstrated utility. Results from one
tool author, one model family or one fixture remain bounded evidence, not a
general benchmark.

## Current portfolio

Tesota has three complementary integrations with retained evidence:

| Capability | Current evidence | Status boundary |
| --- | --- | --- |
| [Oxlint](verification.md) | A selected nine-rule profile and exact input binding; historical correction experiments are retained as records | Native only for the implemented single-file profile; not general repository linting |
| [LemmaScript/Dafny](verification.md#standalone-lemmascript-and-dafny-formal-check) | A seeded proof failure for the production-used invocation predicate was corrected and reverified | Corrective for one bounded formal property; not whole-program correctness |
| [Gentle AI](verification.md#gentle-ai-review-provider) | Candidate-bound review, immutable settlement, correction and one scope-change recovery path were qualified in the [historical experiment record](../experiments/gentle/README.md); the 2.8.0 capability boundary is enforced | Native bounded review provider; review evidence is not a mathematical verifier or acceptance authority |

These tools establish the integration thesis, not the final portfolio. New
verifiers must add a distinct useful oracle or materially improve correction
economics; feature count is not a selection criterion.

## Research candidates

The table records possible tools, not commitments or ordering. A candidate is
selected only when the roadmap's prospective task corpus exposes a defect class
or burden that the tool could address.

| Candidate | Why it may merit qualification | Principal risk or open question | Possible evidence |
| --- | --- | --- | --- |
| Repository-owned compiler, type-checker and test gates | These are often the closest executable expression of the repository's own contract. | Commands may execute plugins, build scripts, tests or descendants. Text output and scope semantics vary by ecosystem. | Admit one fixed gate only after tasks require it; measure correction and stale-result handling. |
| `@shadcn/lint` through Oxlint | It encodes component-specific Tailwind contracts and produces agent-oriented remediation using component, variant and theme context. | Its published evaluation is author-run and task-specific; the Oxlint JavaScript plugin API is alpha. Zero violations does not prove usable UI. | If UI tasks justify it, run paired external-repository tasks and retain violations, visual or behavioral regressions, cost and intervention. |
| Semgrep | Custom rules, JSON and SARIF can make security and repository-policy findings machine-consumable across several languages. | Rule quality determines signal; capabilities vary by engine mode, and suppressions and target discovery affect coverage. | Qualify a small pinned local rule set against real defect fixtures, escapes, suppressions, malformed output and timeout. |
| Playwright plus axe-core | Browser behavior and machine-detectable accessibility findings cover failures static source checks cannot observe. | Browser checks are stateful and can be flaky; automated rules do not establish overall usability or accessibility. | Qualify one deterministic journey and seeded defect in a pinned browser image when a supported task requires it. |
| Ruff or Rust/Cargo/Clippy adapters | Structured language tooling could test whether the contract extends beyond TypeScript. | Generated code, unsafe fixes, procedural macros and build scripts complicate effects and scope. | Select one external repository only after supported work demonstrates the need. |
| fast-check or mutation testing | Counterexamples and mutation scores can improve the oracle rather than only test a candidate. | Meaningful properties must be repository-owned; randomness needs retained seeds, and mutation runs can be expensive. | Compare example-only and property-based correction for an observed invariant. |
| CodeQL/SARIF or OSV-Scanner evidence import | Existing security evidence may be reusable when provenance and freshness are explicit. | Reports need trustworthy result, configuration and producer binding; vulnerability data changes over time. | Qualify historical ingestion and freshness semantics before treating an empty report as evidence. |

## Experiment record

Every qualification must retain enough information for a reader to reproduce
the conclusion and reject an overstated claim:

- task corpus, repositories, committed baselines and selection rationale;
- agent, model and harness identity, with prompts or skills that affect the run;
- verifier, configuration, dependency and execution-environment identity;
- before-check, every diagnostic, every candidate mutation and final recheck;
- timeout, retry, cancellation, unsupported and incomplete outcomes;
- elapsed time, token or monetary cost when available, correction rounds and
  operator interventions;
- control condition, scoring oracle and whether the evaluator is independent;
- limitations, contradictions and the narrowest supported conclusion.

Experiments belong under [`experiments/`](../experiments/README.md), grouped by
capability. A successful experiment may update this queue and the roadmap; it
does not silently broaden task authority or create a native integration.

## External evidence and limits

The September 2026 publication of
[`@shadcn/lint`](https://github.com/shadcn-ui/lint) is a meaningful directional
signal: it makes design-system policy executable, uses diagnostics written for
agent correction, and runs through ESLint or Oxlint. Its
[published evaluation](https://github.com/shadcn-ui/lint/blob/main/docs/evals.md)
reports more than 150 author-run task executions, mostly zero violations after
one feedback round, and a 10--48% correction-cost reduction in its Claude
controls. The same source also limits the claim: the tasks and models are
specific, first drafts did not improve, correction still adds work, and the
evaluator is not independent. Tesota records this as level 1 evidence and a
strong experiment candidate, not as proven general utility or market
validation.

Other primary interfaces support the feasibility of a heterogeneous evidence
portfolio: TypeScript documents check-only use with
[`noEmit`](https://www.typescriptlang.org/tsconfig/noEmit.html); Cargo documents
[versioned metadata and JSON compiler messages](https://doc.rust-lang.org/cargo/reference/external-tools.html);
Semgrep exposes [JSON and SARIF output](https://semgrep.dev/docs/cli-reference);
Playwright exposes [JSON, JUnit and trace-oriented reporters](https://playwright.dev/docs/test-reporters);
Ruff exposes [explicit rule selection and fix applicability](https://docs.astral.sh/ruff/linter/);
fast-check documents [shrunk counterexamples and seeded testing](https://fast-check.dev/docs/introduction/why-property-based/);
axe-core documents [automated findings and explicit incomplete results](https://github.com/dequelabs/axe-core);
StrykerJS documents [mutation-testing support across common JavaScript stacks](https://stryker-mutator.io/docs/stryker-js/introduction/);
GitHub documents [SARIF ingestion from third-party analyzers](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file);
and OSV-Scanner documents [lockfile, SBOM and source scanning](https://google.github.io/osv-scanner/usage/scan-source).
These are interface facts from project owners. They are not evidence that a
Tesota adapter is safe, useful or economical until the qualification protocol
above passes.

The broader conclusion is deliberately narrow: executable, contextual feedback
is becoming a first-class interface for coding agents, and Tesota's existing
verification-first direction is consistent with that change. It does not prove
product-market fit, benchmark superiority or that more verifiers always produce
better software. Tesota's differentiator must be trustworthy composition and
evidence, not the number of logos it can invoke.
