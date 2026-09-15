# Kiln extraction reference

This page records what Tesota should preserve from Kiln and how each candidate
must be qualified. It is a public engineering reference, not an import plan or a
claim that the frozen Kiln branch is supported.

## Audit identity and limits

| Field | Value |
| --- | --- |
| Repository | [`sequelcore/kiln`](https://github.com/sequelcore/kiln) |
| Inspected branch | `dev` |
| Inspected commit | [`9b604b105fbf3644328e187b862233660280b604`](https://github.com/sequelcore/kiln/commit/9b604b105fbf3644328e187b862233660280b604) |
| Commit date | 2026-09-09 07:43:34 UTC |
| Research cutoff | 2026-09-14 |
| Audit type | Selective read-only source, test, architecture and evidence review |

The commit is an explicitly frozen, unverified preservation snapshot. The audit
did not rerun Kiln, its tests, providers or evaluations. Its original Tesota
recommendations were written without inspecting Tesota and have been reconciled
below against the current repository. Source inspection establishes what code
says; it does not establish current runtime behavior.

The resulting policy is [decision 005](../decisions/005-recover-kiln-selectively.md):
recover failure knowledge and contracts aggressively, but import architecture
sparingly.

## Executive classification

The audit classified 42 decision units. Counts describe research decisions, not
percentages of Kiln source code.

| Decision | Count | Meaning for Tesota |
| --- | ---: | --- |
| Recover now | 1 | Extend and qualify an existing Tesota behavior; do not copy the legacy class |
| Adapt semantically | 13 | Preserve the invariant in a Tesota-owned contract |
| Tests or fixtures only | 9 | Port the failure oracle, not its implementation owner |
| Replace externally | 5 | Use Pi, Git, repository tools or qualified isolation instead |
| Postpone | 6 | Wait for a measured problem and a concrete consumer |
| Reject | 8 | Keep outside the current product boundary |

No complete Kiln package is approved for copying. Literal reuse is limited to a
small fragment that wins the matched experiment described in decision 005.

## Reconciled priorities

The audit's `recover now` item—bounded diagnose, correct and recheck—has one
narrow mechanism in Tesota: the approved TypeScript task supplies a failed
scope diagnostic before editing and requires a fresh passing observation. The
actual gap is outcome-relevant, repository-owned checks with the same bounded
authority and evidence semantics.

| Priority | Capability | Current Tesota position | Next proof |
| --- | --- | --- | --- |
| P0 | Approved repository check profiles | One bounded standalone Oxlint profile exists outside the task runtime | Admit one repository-owned build, type or test profile with explicit command identity and effects |
| P0 | Task-sized multi-file work | One proposal-backed TypeScript task admits up to two existing source files | Complete an ordinary small code task with admitted effects and qualified checks |
| P0 | Diagnostic correction | The TypeScript task can consume concrete compiler diagnostics; prospective qualification remains pending | Correct a real repository check without changing or suppressing its oracle |
| P0 | Candidate-bound closeout | Review, decision and guarded promotion exist as separate seams | Present diff, applicable checks, limitations, decision and recovery as one operator task |
| P0 | Pi resource admission | The full SDK experiment uses Pi's default resource discovery | Supply a Tesota-controlled loader before that experiment becomes a general runtime path |
| P1 | Additional verifiers | A tool-specific strategy and research queue exist | Add only a verifier that detects an observed defect class and passes the native qualification contract |
| P2 | Read-only child agent | No production child consumer exists | Compare sequential work with one attenuated, attributable scout before adding orchestration |

Memory, interchangeable engines and custom workflow frameworks remain deferred.
Tesota should expose optional capability providers only behind a stable authority,
candidate, evidence, acceptance and promotion kernel. Methodologies such as SDD,
RDD and TDD are policies or workflows; Gentle is a review provider; Pi is the
current engine. They are not interchangeable implementations of one interface.

## Complete disposition

This compact classification is the canonical public disposition. Exact source
paths must be recorded in the implementing change when a row is activated.

| Decision | Kiln decision units |
| --- | --- |
| Recover now | Bounded diagnose-correct-recheck behavior |
| Adapt semantically | Bounded scope and non-goals; immutable authority revisions; limits versus tripwires; exact candidate subject resolution; candidate succession; producer facts versus assurance and acceptance; Dafny contract semantics; verifier discovery and installation admission; durable action fencing; projected versus observed authority; cumulative budget accounting; canonical global/project configuration; inspectable Shell state |
| Tests or fixtures only | Git candidate capture; Oxlint failure knowledge; LemmaScript qualification protocol; managed recovery checkpoints; child environment and secret-free evidence; provider route-health persistence; formal-screening accounting; static-analysis calibration; source and release qualification |
| Replace externally | TypeScript AST quality analysis; Gentle observer lifecycle; generic command process runner; context transcript projection; skills and instruction inventory |
| Postpone | Artifact and external-state candidates; managed-child attenuation; Memory Lattice; GUI surfaces; autonomous teams and work graphs; context-efficiency evaluation infrastructure |
| Reject | Legacy generic `GateRunner`; generic verifier framework; provider/account pools; Model Gateway and native composite proxy; cross-harness configuration projections; widget/SDK/remote parity; universal control plane; marketplace and roadmap inheritance |

`Replace externally` does not mean ungoverned delegation. Tesota still owns
selection, authority, candidate binding, result validation and lifecycle evidence
for every external capability it admits.

## Regression knowledge to recover first

The most valuable near-term extraction is adverse behavior:

- a fatal verifier exit with plausible clean JSON must not pass;
- a requested or forced process termination remains unconfirmed until physical
  settlement is observed;
- a failed evidence write cannot leave an in-memory value masquerading as a
  durable record;
- stale or foreign candidate, lineage, reviewer and protocol identities fail;
- an old authority revision cannot authorize changed scope;
- recovery preserves cumulative accounting but requires fresh authority;
- source, verifier configuration or relevant dependency drift invalidates
  applicability without deleting the historical observation;
- missing tests, missing executables, malformed output, timeout, cancellation
  and actual findings remain distinct outcomes;
- a future child cannot widen tools, paths, effects, depth or promotion authority.

Three findings were confirmed directly in the inspected source: the Oxlint path
does not independently reject every ordinary nonzero exit when structured output
is otherwise accepted; the process runner can synthesize a `SIGKILL` completion
after a bounded wait without observing the normal close event; and the route
health store mutates its cache before confirming its JSON write. These are test
inputs, not accusations that every supported Kiln operation is exploitable.

## Evidence policy

Historical Kiln results remain author-reported unless their raw package is
replayed. The audit found a previously reported Windows source qualification and
three executed recovery cases at a different commit, but that evidence cannot
qualify the frozen `dev` snapshot or Tesota's adaptation.

Evaluation summaries may nominate an experiment. They do not establish product
utility without the task corpus, exact model-plus-harness identity, comparable
budgets, raw trials, invalid-run accounting, residual-defect assessment and
operator-effort measurement. The [verifier strategy](../verifier-strategy.md)
owns the corresponding admission levels and current external research.

Public claims should remain narrow:

- Tesota incorporates lessons from a pinned Kiln source audit;
- selected contracts and failure oracles may be adapted incrementally;
- no whole Kiln package has been imported;
- neither the audit nor a third-party benchmark establishes Tesota's general
  productivity, security or correctness.

## Adoption record

When a row becomes implementation work, record:

1. the concrete Tesota problem and current owner;
2. the pinned Kiln commit, path and symbol inspected;
3. whether code, semantics, a test or only an idea survived;
4. removed Kiln dependencies and vocabulary translations;
5. Tesota-side positive, adverse and recovery tests;
6. attribution and license obligations;
7. measured result and remaining unsupported cases.

This record prevents research classifications from silently becoming product
status and preserves the value of Kiln without restoring its package topology.
