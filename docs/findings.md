# Findings

What earlier experiments established, in one place. The full protocols,
transcripts, oracles and machine evidence were removed from the working tree on
2026-09-24; they remain in Git at
[`b8d28484`](https://github.com/sequelcore/tesota/tree/b8d28484f9df46291763c0b44665129d3c1bddb0/experiments).
Each result holds only for the source, toolchain, platform and date it was
observed on. None of them establishes representative usefulness.

## Coding tasks through the shell

| Date | What was tried | Outcome | Lesson |
| --- | --- | --- | --- |
| 2026-09-19 | Three preselected public TypeScript fixes (`supported-task/`) | 0 of 3 reached a proposal. Discovery exited early; tracked symlinks and hardlinked Bun installs were also refused. | Setup and repository-shape restrictions blocked real work before the model did anything. |
| 2026-09-22 | Practical-use pilot against a comparator agent (`practical-use/2026-09-22-*`) | A read-only answer was useful. The source-and-test case failed in discovery; the comparator's shell also failed. | Discovery failures needed a visible cause. |
| 2026-09-23 | Repeated and fresh source-and-test fixes on one external repository | Two accepted and applied results. The fresh case failed its first check and was repaired. | The source-and-test flow can finish on a small, well-shaped task. |
| 2026-09-23 | Three-repository sample | One useful answer (`tgrep`), one applied source-only fix (`sysone-memory`), one `execution_failed` (`utils-title-case`: its check tool was denied at the operation boundary). | Fixed task shapes break on ordinary variation. |
| 2026-09-23 | Two-session shell workspace walkthrough | Approval binding, an independent answer, an accepted external fix and restart all worked. A stale progress defect was found and fixed. | Parallel sessions work for the exercised case; split view and interrupted restart were not exercised. |
| 2026-09-23 | Combined Node test + typecheck on the same candidate | The first fresh attempt ended with unconfirmed execution. A later internal run succeeded after three failed attempts and took about 64 minutes. | Repeated dependency snapshots made review, decision and application unusably slow. |
| 2026-09-23 | Execution repair on a one-file fixture | 149 s from scope prompt to applied result, including operator waits; about 27 s of execution. Host-local checks worked without Docker. | Reusing task-owned dependency input fixed the snapshot cost. A CRLF conversion blocked one attempt before approval. |

## General coding loop

| Date | What was tried | Outcome | Lesson |
| --- | --- | --- | --- |
| 2026-09-24 | One live run of the new loop on a throwaway two-file JavaScript repository: fix a subtraction bug and add a `node:test` file, with commands denied | About 17 s. The agent edited one file and created another without requesting a command. `node --test` passed on the reviewed tree, and both files were applied. | The general loop does in one request what the fixed shapes could not: it created a new file. Not yet exercised in the interactive shell or on a real repository. |
| 2026-09-25 | Autonomous loop in a Docker Sandboxes microVM on a throwaway JavaScript repository | Sandbox ready in 5 s. The agent ran `npm test`, fixed the bug and reran the tests without any approval prompt, in 20 s; the fix was applied. The `npm test` check still failed inside because the sandbox has Node 22, where `node --test src/` did not resolve. | Isolation works; toolchain parity with the repository is the next gap. |
| 2026-09-25 | Sandbox preparation on Tesota's own repository | mise, Node 24.15.0, Bun 1.4.2 and `bun install --frozen-lockfile` in 69 s; `bun run typecheck` passed inside in 2 s; the next preparation was skipped in 2 s; nodejs.org returned 403 afterward. A first attempt found that removing a sandbox rule needs `--force` without a terminal; the provider deleted the sandbox instead of leaving setup hosts open. | Pinned runtimes plus a setup-only network window give the sandbox the repository's toolchain. Bun installed through the proxy. |
| 2026-09-25 | Cached toolchain kit and a dependency volume on Tesota's own repository, two sessions | Each session was prepared in 31 s (previously 116 s, then 70 s); `bun install` wrote to the sandbox's disk in about 3 s instead of 60 s through the mount; `bun run typecheck` passed in 2 s; the host `node_modules` stayed empty and `git status` clean. A kit directory named with a leading digit was rejected by `sbx` as an unknown agent. | Toolchain reuse is an image-build cache, not a per-session download; dependency I/O belongs on the sandbox's own disk. |
| 2026-09-25 | Live agent asked to fetch example.com in an autonomous sandbox | The first `curl` was refused; the policy log named `example.com:443`; the operator was asked once and allowed it for the session; the agent reran the command unprompted and answered "Example Domain". | A refused destination can become an operator question after the command, without the proxy holding the connection. |
| 2026-09-25 | Redesigned shell with a live agent turn on a throwaway JavaScript repository, rendered off-screen at 110 columns | 198 streamed updates became one growing reply; nine tool calls showed as one line each, commands with their last output lines; eleven entries were recorded for restore. The agent fixed the subtraction and its direct test run passed, but `npm test` (`node --test src/`) still failed in the sandbox's default Node, which the repository did not pin. | Streaming the agent's work makes a long turn legible. Toolchain parity still depends on the repository pinning its runtime. |
| 2026-09-25 | Tesota's reviewer on four frozen candidates whose checks passed: a `>= 100` boundary for "over $100", a test weakened from 16 to 15 with the 15% rate unchanged, CSV export without the requested logging, and a correct control | All three defects reported as `fixable`, the weakened test also as `operator`; the control had no findings. One extra finding (unescaped CSV fields) was real but unrequested. Severity for the same defect was `high` in one run and `medium` in another. Each review took 2 to 25 s and left the tree unchanged. | Review catches what passing checks miss when the defect is visible against the request. Four cases show feasibility, not a detection rate; severity is not stable across runs. |
| 2026-09-25 | The whole loop through Tesota's shell loop with a sandboxed worker, `npm test` and the reviewer: first unseeded ("Orders over $100 get a 10% discount, and totals are rounded to whole cents"), then with a seeded first attempt using `>= 100` and no rounding | Unseeded: the worker got the boundary and rounding right, the review was clean, 29 s. Seeded: checks passed; the first run's reviewer answered in prose without submitting, which showed as an unfinished review and started no correction. After adding one reminder, the reviewer reported missing rounding (high) and untested rounding and $100 boundary (medium); correction round 1 fixed both, the re-review was clean, 31 s in total. The reviewer did not name `>= 100` itself as the defect. | The loop corrects before the operator decides. A reviewer can skip its structured submission, so one bounded reminder is needed; an unfinished review must never pass as clean. |
| 2026-09-25 | LemmaScript 0.6.1 with Dafny 4.11 as a Tesota verifier on `canAccess(denied, allowed)` annotated with "denied implies false" and "not denied and allowed implies true", once correct and once with the denial weakened to `denied && !allowed` | The correct version passed and the claim listed both proved annotations; the weakened version failed, with Dafny naming the "denied implies false" postcondition and its return path. About 2 s each, in a private copy so the candidate was not written. | A proof can gate a candidate the way a test does, and its failure points at the violated property. |
| 2026-09-25 | ClaimCheck's method through Tesota's model route, on two proved `canAccess` contracts against "a denied path is never accessible, whether or not it is also allowed": one with `ensures denied ==> false`, one narrowed to `ensures denied && !allowed ==> false` | Both proofs passed. The matching contract had no findings (6 s); the narrowed one was reported as not expressing the request because it "leaves denied && allowed unconstrained, missing the key precedence case" (7 s). | A passing proof can prove less than was asked; the round trip catches it. Two cases show feasibility, not a detection rate. |
| 2026-09-25 | `gentle-ai review status --contract gentle-ai.review-integration/v2 --agent pi` (2.5.0-rc.1) on a throwaway repository with one change | Refused before any mutation: `immutable_review_transport_unsupported`; Pi is admitted only while the gentle-pi host declares its relay contract. | Gentle AI's review cannot be integrated honestly until it admits other hosts. |
| 2026-09-25 | `bun run live:review`, eight frozen candidates with known truth: four seeded defects (a `>= 100` boundary, a test weakened to 15% with the rate unchanged, CSV export without the requested logging, an authority check that lets any author field through), a pre-existing bug the change does not touch, a correct control and two baits (correct code that reads like a bug, and correct code for a loosely worded request); a planted false claim on each of the four correct candidates | Reviewer: 4 of 4 seeded defects, 0 false positives, no finding on the baits or the untouched bug. Refuter: confirmed all 4 real defects, refuted all 4 planted false claims, and refuted one real but pedantic finding (an empty no-op test replaced); 3 to 14 s when there were findings, none otherwise. An earlier run scored three real secondary findings as false positives until the set gained a category for them. | On small candidates this reviewer rarely raises false findings, so the refuter's gain shows only on planted claims; harder cases from real use are needed. The refuter keeps real defects and removes false ones here. |

## Isolation

- **Docker** (2026-09-13): the pinned Node container passed every control:
  outside reads and writes, network, credentials and cancellation.
- **Codex CLI sandbox 0.154.0** (2026-09-13): failed the outside-read and
  network controls.
- **Anthropic sandbox runtime (SRT) on Windows** (2026-09-23): a real
  TypeScript check ran, and a private fixture confined its own files. A
  separate host tree with broad inherited permissions stayed accessible, and
  there is no configurable memory, CPU or process limit. Not qualified for
  repository tasks; see [decision 007](decisions/007-execution-environments.md).

## Verification and review tools

- **Oxlint** (2026-09-11): of 105 rules from Kiln's analyzer, only size and
  complexity limits fired on Tesota's source. Five correctness rules were
  adopted as `oxlint-static/v2` (now v3); structural limits were rejected.
- **Gentle AI review provider** (2026-09-11 to 09-13): the contract,
  capability negotiation, candidate binding, stale-target rejection and one
  accepted high-risk review lineage passed. Correction was once blocked by
  model availability, and recovery after a stopped review was rejected until
  its scope changed.
- **LemmaScript/Dafny**: proves the invocation-budget predicate only. It is a
  standalone check, not part of `bun run check`.

## Model route

- **Codex through Pi**: saved-login probes pass for a normal turn and an
  observed cancellation. Earlier device-code and browser probes failed before
  inference; the history is in `experiments/codex/history.md` at the commit
  above.
- **Retired fixture exercises**: a single-tool Oxlint verification and a
  one-file debugger-removal correction both passed with the live model. Their
  commands were removed.
