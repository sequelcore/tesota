# Tesota becomes a verification layer

Status: Accepted on 2026-10-08. Built in refactor slices 1–8 on `dev`,
documented in slice 9 ([#355](https://github.com/sequelcore/tesota/issues/355)),
and carried to version 0.1.0 by the later work in the table under
[Slices](#slices).

## Context

Until 2026-10-08, Tesota was a full coding agent built on Pi. It owned the
whole harness:

- model routes, accounts and usage;
- sandboxes and where commands ran;
- the session's copy of the workspace and applying results;
- reviewers, refuters and obligations;
- an advisor, explorers, web search, a plan tool and a session shell.

Verification was one behavior among many, and each of the others needed
upkeep that general harnesses already provide. Pi 1.1's extension API can
hold a run open before it settles, add session entries and register tools.
A prototype showed that this API carries a verification layer without the harness.

The harness decisions are recorded in the
[decision log](https://github.com/sequelcore/tesota/blob/16136ce98f6476f5d4422261bb9ff24fe497b2d1/docs/decisions.md)
(001–051, as of 2026-09-29), in
[`docs/decisions/`](https://github.com/sequelcore/tesota/tree/d0c03f66/docs/decisions)
and in the design documents at `d0c03f66`, the last commit before the
harness was removed. Code comments and issues still cite their numbers. This
record uses a date for its name so it cannot collide with them.

## Decision

Tesota stops being a coding agent. It becomes an open verification layer: a
Pi package and a `tesota` command that opens Pi with it. It makes the agent
show evidence that its change does what was asked:

- proved where it can, through LemmaScript and Dafny;
- tested where it cannot, through the project's own commands;
- and it says what it could not verify.

It verifies results, not actions. It owns no harness infrastructure: Pi and
the operator decide which model runs, where commands run and what the agent
may do. Tesota has no verifier of its own; it runs existing ones and keeps
their evidence apart from a model's judgment and from human acceptance.

Clarified on 2026-10-09
([#385](https://github.com/sequelcore/tesota/issues/385)): owning no harness
infrastructure means not rebuilding it. Tesota builds verification and
composes the rest. It adds to the harness through Pi's public extension
points, as its launcher, theme, header and footer do, and it may carry or
recommend existing Pi packages. It does not rebuild a sandbox, a session
engine, model routes or search that Pi or an existing package provides,
which is how the earlier harness and Kiln grew.

Widened on 2026-10-09
([decision record](2026-10-09-plain-language-rules.md)): the change can be
any work done with a coding agent, not only code. The person states the
rules of their field in plain words, and Tesota checks the checks.

### Reversed

These harness decisions no longer apply. Slice 1 removed what was built of
them:

- **The general-purpose harness and its build order:** 012, 013, 032.
- **Execution:** environments, autonomy, every sandbox, and where commands
  run: 014, 025, 030, 037, 043, 044, 047, 048 and 049.
- **Model access, which Pi owns:**
  - routes, gateways, accounts and usage: 021, 031, 050, 051;
  - the chatgpt route and the claude-code route terms (`docs/decisions/` at
    `d0c03f66`).
- **Agents around the result:**
  - reviewers, refuters, obligations and extras: 015, 016, 018, 034, 045;
  - their measurement: 023;
  - the Jev triage model: 035;
  - judge warnings: 028;
  - who acts on a finding: 041.
- **The agent and its session:**
  - models, levels and switching by role: 020, 026, 029;
  - the engine contract: 022;
  - explorers and the advisor: 019, 027;
  - web search: 024;
  - the plan tool: 033;
  - session naming: 036;
  - the reply style: 046;
  - the session lifecycle and the session service: 038, 017;
  - repository analysis providers (`docs/decisions/` at `d0c03f66`).
- **The workspace copy and applying results:** 042.
- **Checks re-run on the base and sensitive paths:** 039, 040, 052, 053.
  The proved check-origin rule and the JUnit report reader stay, for one
  question only: whether a changed test exercises the change.

### Still standing

- **001:** Tesota and its relation to Kiln.
- **002:** Pi's public APIs, with Tesota owning verification and evidence.
  This record narrows it to verification alone.
- **005:** Kiln is recovered selectively.
- **008:** the repository name.
- **009:** the branch rules.
- **010:** public writing leads with what the person can do.
- **011, as narrowed by 013:** a capability needs a real consumer, and is
  measured when it claims an improvement.
- **From 003:** a passing check is not acceptance.

006's identity, "Work that carries its evidence", gives way to the README's
wording.

## Consequences

- Tesota runs only inside Pi 1.1.0 or later. Proofs need Dafny on the
  operator's computer.
- Tesota is not a security boundary and offers no sandbox. What the agent
  may do is left to Pi and the operator.
- Earlier sessions, routes and settings do not carry over. There are no
  compatibility paths, since nothing had been released.
- What Tesota could not verify is stated in the receipt, never hidden by a
  passing check.

## Slices

Each slice landed on `dev` through its own pull request.

| Slice | Issue | Pull requests |
| --- | --- | --- |
| 1. Remove the harness and scaffold the package | [#334](https://github.com/sequelcore/tesota/issues/334) | [#335](https://github.com/sequelcore/tesota/pull/335), [#336](https://github.com/sequelcore/tesota/pull/336) |
| 2. Verifier interface and LemmaScript | [#337](https://github.com/sequelcore/tesota/issues/337) | [#338](https://github.com/sequelcore/tesota/pull/338) |
| 3. The gate and the receipt | [#339](https://github.com/sequelcore/tesota/issues/339) | [#340](https://github.com/sequelcore/tesota/pull/340) |
| 4. Weakened evidence | [#341](https://github.com/sequelcore/tesota/issues/341) | [#343](https://github.com/sequelcore/tesota/pull/343) |
| 5. Test rung | [#342](https://github.com/sequelcore/tesota/issues/342) | [#344](https://github.com/sequelcore/tesota/pull/344) |
| 6. Contract strength | [#345](https://github.com/sequelcore/tesota/issues/345) | [#346](https://github.com/sequelcore/tesota/pull/346), [#348](https://github.com/sequelcore/tesota/pull/348) (Dafny in CI) |
| 7. Receipt for pull requests | [#347](https://github.com/sequelcore/tesota/issues/347) | [#349](https://github.com/sequelcore/tesota/pull/349) |
| 8. Evaluation | [#350](https://github.com/sequelcore/tesota/issues/350), [#352](https://github.com/sequelcore/tesota/issues/352) | [#351](https://github.com/sequelcore/tesota/pull/351), [#353](https://github.com/sequelcore/tesota/pull/353) |
| 9. Documentation | [#355](https://github.com/sequelcore/tesota/issues/355), [#358](https://github.com/sequelcore/tesota/issues/358) | [#357](https://github.com/sequelcore/tesota/pull/357), [#359](https://github.com/sequelcore/tesota/pull/359) |
| 11. Identity | [#360](https://github.com/sequelcore/tesota/issues/360) | [#361](https://github.com/sequelcore/tesota/pull/361) |
| Input and footer | [#362](https://github.com/sequelcore/tesota/issues/362) | [#363](https://github.com/sequelcore/tesota/pull/363) |
| Receipt false alarms: added tests, test files and comment-only lines | [#364](https://github.com/sequelcore/tesota/issues/364), [#366](https://github.com/sequelcore/tesota/issues/366) | [#365](https://github.com/sequelcore/tesota/pull/365), [#367](https://github.com/sequelcore/tesota/pull/367) |
| 12. Alpha, part 1: package readiness | [#368](https://github.com/sequelcore/tesota/issues/368) | [#369](https://github.com/sequelcore/tesota/pull/369) |
| Tesota's theme as the `tesota` command's default | [#370](https://github.com/sequelcore/tesota/issues/370) | [#371](https://github.com/sequelcore/tesota/pull/371) |

The [verification design](../design/verification.md) describes what the
slices built.
