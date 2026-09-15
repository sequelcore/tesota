# Roadmap

Tesota's product goal is a normal agent experience in which useful work arrives
with applicable evidence and a clear adoption decision. Software development is
the first proving ground; it is not the permanent boundary of the product.

The roadmap expands only after the preceding boundary is useful and qualified.
Feature count, internal state-machine breadth and benchmark headlines are not
completion criteria.

## Current baseline

Implemented today:

- interactive, bounded repository questions and one clarification;
- retained, non-authoritative task proposals over a committed baseline;
- operator-approved documentation changes to one or two existing files;
- independent candidate checkouts and grant-derived read/write tools;
- automatic scope-integrity evidence with explicit human-review limits;
- exact-candidate review, local acceptance and guarded promotion;
- durable outcome accounting for started or declined supported proposals;
- bounded Oxlint, Dafny, Pi, Gentle AI and isolation qualification slices.

The ordinary task runtime contains no registered demos or Tesota-specific task
definition. Historical experiments remain evidence of mechanisms, not active
product routes. See [experiments](../experiments/README.md) and
[project history](history/README.md).

## Next qualification gates

### 1. Outcome accounting foundation — implemented

Record first-pass result, correction attempts, operator intervention, elapsed
time, known consumption, acceptance and promotion outcome for prospective tasks.
Include refusals and failures.

The supported flow records scope refusal, cancellation, failure, review decision
and promotion; it also reports elapsed time and observed model, tool and edit
counts. Token usage and cost remain explicitly unavailable.

Prospective live evaluation is deferred until gates 2 and 3 admit ordinary
repository checks and task-sized code changes. Exercising documentation-only
work would measure a temporary product restriction and encourage artificial
repository changes rather than representative usefulness. When live evaluation
resumes, it must include refusals and failures; a small pilot will report counts
and causes rather than a reliability percentage.

### 2. Approved repository check profiles

Admit one repository-owned build, typecheck or targeted-test command with exact
executable, arguments, working directory, configuration, relevant inputs,
environment policy, timeout and settlement semantics.

Explicitly unsupported in this increment: arbitrary manifests, installs,
automatic network access, model-selected replacement checks and silent fallback
to ambient executables.

Exit evidence: real positive, failing, missing-tool, no-tests, fatal-exit,
timeout, cancellation, surviving-descendant and source-drift cases on each
supported platform.

### 3. Task-sized code changes

Extend the admitted grant to a small existing-file source/test write set whose
repository checks were qualified in gate 2. Scope expansion returns to approval.
Dependency changes, migrations and gate weakening remain excluded.

Exit evidence: prospective bug fixes and small features in external fixture
repositories, with no unauthorized effects and independent residual-defect
assessment.

### 4. Diagnostic correction

Allow at most two correction attempts under one cumulative task budget. Every
candidate change receives a new identity and fresh applicability assessment.
The agent cannot modify its own grant or authoritative check definition.

Exit evidence: higher accepted-task completion or lower operator effort without
increased held-out defects, including the cost of unsuccessful corrections.

### 5. Recoverable closeout

Make execution, evidence persistence, review settlement and promotion recovery
explicit without exposing internal identifiers in the normal shell experience.

Exit evidence: restart tests at every durable boundary, wrong-candidate review,
stale acceptance and lost promotion acknowledgement. Uncertain effects must not
be replayed as though nothing happened.

### 6. Task-relevant verifier breadth

Select browser/accessibility, security, property-based, design-system or formal
checks only in response to observed task needs. Reuse external engines and keep
their evidence semantics distinct.

Exit evidence: unique useful findings or lower residual defects justify each
integration's runtime, maintenance and false-positive cost.

### 7. Optional delegated work

The first possible subagent is a read-only scout with a strict subset of parent
authority, attributable output, no grandchildren and no acceptance or promotion
power.

Exit evidence: a sequential-versus-delegated comparison demonstrates net value
and passes escalation, cancellation and stale-parent tests. Otherwise delegation
does not enter the product.

## Deferred by evidence

No current milestone includes a universal control plane, model gateway, account
pool, memory graph, generic verifier framework, marketplace, GUI parity or
autonomous team system. These are reconsidered only when a named consumer and a
measured problem justify their ownership cost.

The [Kiln extraction reference](references/kiln-extraction.md) preserves relevant
failure knowledge without making Kiln's architecture or roadmap normative.
