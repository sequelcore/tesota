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
| 2026-09-26 | Autonomous loop in a Docker Sandboxes microVM on a throwaway JavaScript repository | Sandbox ready in 5 s. The agent ran `npm test`, fixed the bug and reran the tests without any approval prompt, in 20 s; the fix was applied. The `npm test` check still failed inside because the sandbox has Node 22, where `node --test src/` did not resolve. | Isolation works; toolchain parity with the repository is the next gap. |
| 2026-09-26 | Sandbox preparation on Tesota's own repository | mise, Node 24.15.0, Bun 1.4.2 and `bun install --frozen-lockfile` in 69 s; `bun run typecheck` passed inside in 2 s; the next preparation was skipped in 2 s; nodejs.org returned 403 afterward. A first attempt found that removing a sandbox rule needs `--force` without a terminal; the provider deleted the sandbox instead of leaving setup hosts open. | Pinned runtimes plus a setup-only network window give the sandbox the repository's toolchain. Bun installed through the proxy. |
| 2026-09-26 | Cached toolchain kit and a dependency volume on Tesota's own repository, two sessions | Each session was prepared in 31 s (previously 116 s, then 70 s); `bun install` wrote to the sandbox's disk in about 3 s instead of 60 s through the mount; `bun run typecheck` passed in 2 s; the host `node_modules` stayed empty and `git status` clean. A kit directory named with a leading digit was rejected by `sbx` as an unknown agent. | Toolchain reuse is an image-build cache, not a per-session download; dependency I/O belongs on the sandbox's own disk. |
| 2026-09-26 | Live agent asked to fetch example.com in an autonomous sandbox | The first `curl` was refused; the policy log named `example.com:443`; the operator was asked once and allowed it for the session; the agent reran the command unprompted and answered "Example Domain". | A refused destination can become an operator question after the command, without the proxy holding the connection. |

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
