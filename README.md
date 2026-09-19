# Tesota

**An open-source, verification-first agent.**

Describe what you need and work with Tesota toward a result you can inspect,
correct and decide whether to use. Tesota keeps applicable checks connected to
the exact result they describe and shows what those checks establish, what they
do not establish and whether the result has been applied.

> **Work that carries its evidence.**

Software development is Tesota's first proving ground, not the permanent limit
of the product. The current implementation is pre-release, local,
terminal-first and deliberately narrow.

## The experience

The intended product experience starts with an ordinary request:

```text
cd my-project
tesota

> Fix the session timeout bug.
```

Tesota first inspects a committed repository baseline through a bounded,
read-only view. It can answer a repository question, ask one clarification or
propose supported work. For a supported change, the same shell shows the
proposed scope and checks, asks for approval, works in an independent checkout,
presents the exact diff and current evidence, and asks whether to apply the
result. The normal path does not require copying proposal, candidate or review
IDs.

That continuous experience is not complete yet. After a known-settled task,
including cancellation or a lifecycle failure before uncertain effects, the
shell returns to a new prompt. Unconfirmed execution or application settlement
ends the session, and a user cannot request a semantic revision such as "change
this part" within the same task. The [roadmap](docs/roadmap.md) defines those
user-facing gaps.

## Why verification-first

Producing an answer or a change does not establish that it is correct. Tesota
keeps the work and its evidence connected so a user can answer four practical
questions:

1. What exact result exists?
2. Which checks ran against this result, and under what conditions?
3. What do those checks leave unknown?
4. Was this result only reviewed, or was it actually applied?

A useful summary is specific instead of collapsing those distinctions into a
single "verified" badge:

```text
Changed:
- src/auth.ts
- src/session.ts

Checked:
PASS Scope integrity: only admitted files changed
PASS TypeScript no-emit: this exact result passed typescript-no-emit/v1

Not established:
- requested behavior and completion conditions
- full integration suite

Changed since checking: No
Application: Not applied; awaiting your decision
```

The current shell renders this structure before the application decision and
reports the terminal application state in the retained task outcome.

## What works today

Tesota currently supports a small but real software-development slice:

- ask bounded questions about the committed repository and continue one
  clarification;
- describe a small change without naming internal lifecycle IDs;
- propose and approve a change to one or two existing non-test TypeScript files
  below `src/`;
- let the agent work in an independent checkout with grant-derived tools;
- run scope-integrity and the repository's admitted no-emit TypeScript profile;
- use bounded diagnostics for the current correction loop;
- review the exact diff and evidence before accepting or rejecting it;
- apply accepted bytes only after conflict checks; and
- inspect retained outcome history after a completed, declined or interrupted
  attempt.

Pi is the current agent engine. Codex is the configured model route for
the supported live flow. Neither is Tesota's product identity. Engines, models,
reviewers and verifiers participate behind Tesota-owned work, evidence and
adoption boundaries.

## Try the supported workflow

Tesota is not published to a package registry. Use Bun 1.4.2 and Node 24.15.0
from a source checkout:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun link
tesota auth login
```

Then open a supported TypeScript repository and start the shell:

```sh
cd my-project
tesota
```

Ask a repository question or describe a small change. Tesota will stop without
editing when the request, repository shape, working state or required check is
outside the current boundary. A supported change still requires explicit scope
approval and a separate review decision before application.

The current repository TypeScript check requires Docker Desktop, the pinned
image already present locally and a matching TypeScript closure in the target
repository's `node_modules`. When the installed TypeScript package declares a
Linux/x64 platform package, the closure must include
`@typescript/typescript-linux-x64` at the declared TypeScript version. Tesota
performs no dependency install or image pull. See
[Using Tesota](docs/using-tesota.md) for the complete current path and its
failure and recovery boundaries.

`bun link` points the global `tesota` command at this checkout. Run `bun unlink`
here to remove it.

## Current limits

Tesota does **not** currently support arbitrary repository work, test edits, new
or deleted files, unrestricted commands, dependency changes, general web
research, untrusted workloads or non-code workflows. It does not offer a stable
API or a general security guarantee. Its supported repository task is narrower
than the long-term product thesis.

Bounded Oxlint, Dafny, Gentle AI and isolation experiments provide evidence for
specific mechanisms. They do not establish arbitrary task execution or general
product utility. The next important proof is ordinary usefulness on
preselected external tasks, including failures and refusals.

## Go deeper

| Read | Question answered |
| --- | --- |
| [Using Tesota](docs/using-tesota.md) | How does one complete supported workflow behave today? |
| [Identity and purpose](docs/identity.md) | What product is Tesota trying to become, and why verification-first? |
| [Roadmap](docs/roadmap.md) | Which useful user capability is next, and what evidence would demonstrate it? |
| [Qualification](docs/qualification.md) | What engineering evidence must support a milestone claim? |
| [Architecture](docs/architecture.md) | How do the internal lifecycle, authority and evidence owners work? |
| [Development](docs/development.md) | How do contributors build, test and document the repository? |
| [Task contract](docs/tasks.md) | What exact task scope, checks, review and application rules are implemented? |
| [Proposals](docs/proposals.md) | How does bounded read-only discovery produce non-authoritative proposals? |
| [Candidates](docs/candidates.md) | How are independent working copies created, inspected and retained? |
| [Verification](docs/verification.md) | What does each implemented check observe and bind? |
| [Verifier strategy](docs/verifier-strategy.md) | How are possible verifier integrations evaluated? |
| [Experiments](experiments/README.md) | Which bounded mechanisms have retained experimental evidence? |

## Origin and license

Tesota emerged from a deliberate reset of Kiln. The lesson was not that Kiln
had no value; it was that infrastructure and scope expanded faster than
demonstrated everyday usefulness. Tesota preserves Kiln's strongest failure
knowledge and invariants while recovering infrastructure only for a current
consumer and measured problem.

The [reconstruction decision](docs/decisions/001-start-tesota.md) records that
direction. The protected
[`kiln-legacy-2026-09`](https://github.com/sequelcore/tesota/tree/kiln-legacy-2026-09)
tag fixes the final Kiln development state; the active `main` and `dev` branches
belong to Tesota. The [Kiln reference](docs/references/kiln.md) explains how
historical code and tests may be studied without inheriting Kiln's roadmap.

The project is prepared for public development under Apache-2.0. Preserve
[LICENSE](LICENSE), [NOTICE](NOTICE) and retained third-party notices. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.
