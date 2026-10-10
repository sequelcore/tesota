# Verification for any work done with a coding agent

Status: Accepted on 2026-10-09 as a direction. Nothing in it is built yet.
It comes after the alpha
([#372](https://github.com/sequelcore/tesota/issues/372)), starting with a
pilot on one real task that is not code.

## Context

Tesota verifies code: it proves contracts, runs the project's commands and
measures contracts by mutation
([verification design](../design/verification.md)). People who use coding
agents such as Claude Code, Codex or Pi also use them for work that is not
code: budgets, reports, spreadsheets and PDFs. That work needs evidence just
as much, and the people doing it are often not programmers.

The gate already runs commands it does not understand: it finds each
project's commands (`src/projects.ts`) and records each one as "`command`
passes with these changes" (`src/test-rung.ts`). Three things keep that from
serving other work today:

- it reads commands only from project manifests, such as `package.json`;
- it verifies nothing outside a Git repository
  ([#384](https://github.com/sequelcore/tesota/issues/384));
- the receipt names every such result "Tests pass".

## Decision

Tesota's gate becomes independent of the field. Tesota owns the discipline;
the person owns the rules of their field.

- **Tesota owns** the gate, which holds a run until its checks pass, the
  receipt, and checking the checks.
- **The person states rules in plain words,** such as "the November budget
  must not change", and the agent turns each rule into a check.
- **Tesota builds no verifier for a field,** such as spreadsheets, PDFs or
  law. A generic oracle that serves every field, such as confirming that a
  quoted figure appears in its source, may be considered on its own.
- **Where no check can exist,** as for "the report must be persuasive", the
  receipt says the result needs human acceptance.

A rule becomes a check in six steps:

1. The person writes the rule in plain words.
2. The agent asks about what the rule leaves open, such as the total or each
   line, and which file.
3. The check is written before the work, apart from it, and then kept
   unchanged. Tesota flags any later edit to it.
4. The person approves the check through concrete cases, not through a
   description of it: "If November's rent went from 1,200 to 1,300, should
   the work stop?"
5. Tesota shows that the check can fail: it plants a violation in a copy
   and confirms the check catches it.
6. The check runs on every change, and the run does not settle until it
   passes.

## Evidence

Research up to 2026-10-09, from abstracts, official documentation and
project pages; the full papers were not read.

- **Rules become checks well, but not always.** Turning informal intent into
  checkable specifications is an open problem, and "there is no oracle for
  specification correctness other than the user"
  ([Lahiri, 2026](https://arxiv.org/abs/2603.17150)). Across 24 models and
  40 tasks, "none of the LLMs were able to correctly formalize all the
  tasks", and generated tests exposed wrong formalizations
  ([Prasetya et al., 2026](https://arxiv.org/abs/2603.17193)). Hence steps
  4 and 5.
- **People judge cases better than descriptions.** Approving or rejecting
  generated tests, rather than code, raised accuracy by 45.97 points on
  average within five interactions, in an automated evaluation
  ([TiCoder](https://arxiv.org/abs/2404.10100)). Business professionals
  given natural-language explanations of an AI's analyses "frequently failed
  to detect critical flaws", even when told the AI makes mistakes
  ([Virk and Liu, 2025](https://arxiv.org/abs/2508.06484)). Hence step 4
  uses cases.
- **A check must be shown able to fail.** Meta generates tests guided by
  mutants in production; engineers accepted 73% of them in test-a-thons
  ([Foster et al., 2025](https://arxiv.org/abs/2501.12862)). Tesota measured
  the same effect on contracts: a weak contract sent back led to a contract
  that ruled out the registered bug in 15 of 15 runs, against 2 of 15
  without it ([#351](https://github.com/sequelcore/tesota/pull/351),
  [#353](https://github.com/sequelcore/tesota/pull/353)).
  Hence step 5.
- **An agent that grades its own work cheats.** When tests contradicted the
  task, GPT-5 passed 76% of one variant by cheating, and Anthropic's models
  mostly by editing the tests. Read-only tests stopped the edits but not
  special-casing ([ImpossibleBench, 2025](https://arxiv.org/abs/2510.20270)).
  Claude Code's guidance is to have "one Claude write tests, then another
  write code to pass them"
  ([best practices](https://code.claude.com/docs/en/best-practices)), and
  AgentCoder separates the two because tests written with the code "can be
  biased and affected by the code"
  ([Huang et al., 2023](https://arxiv.org/abs/2312.13010)). Hence step 3.
- **Tools do this for code only.** Kiro turns requirements into properties
  and tests them ([Kiro](https://kiro.dev/docs/specs/correctness/)). No
  tool was found that does it for budgets, reports or other work that is
  not code.

## Consequences

- Tesota stays a verification layer for coding agents. The people in scope
  use coding agents; their work need not be code.
- Work outside a Git repository is checked as it stands, and the receipt
  marks that evidence weaker: there is no base to compare against
  ([#384](https://github.com/sequelcore/tesota/issues/384)).
- A check can be declared without a project manifest, with the claim it
  supports, and the receipt names it by that claim, not "Tests pass".
- Risks that remain: a check can be wrong in a case the approved cases did
  not cover, and an agent can still pass by special-casing. Step 5 narrows
  both without closing them.

## Open questions

- How a person declares a rule, and where its check and approved cases are
  kept.
- How Tesota plants a violation in a file that is not code, such as a
  spreadsheet or a PDF.
- How the check is written apart from the work in Pi: in a separate session,
  or through an existing package.
- The pilot: one real budget or report, its rule and check written first,
  to find where the flow breaks before any issue is filed.
