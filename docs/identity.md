# Identity and purpose

Tesota is a local coding agent in development, built around verifiable changes
and human control. It is intended for developers working on a repository who
want help carrying a task through implementation, checking and review.

This page defines the product's direction. The [roadmap](roadmap.md) records
progress toward it; the [architecture](architecture.md) describes what exists.
Tesota executes a small application-owned registry of bounded tasks, including a two-file task;
general operator-defined repository tasks are not yet supported.

## Why Tesota exists

A useful coding agent needs to carry work through to a result someone can assess.
That means understanding the requested change, acting within its scope, running
relevant checks, correcting failures and explaining what remains uncertain.
Tesota aims to make that complete development cycle dependable and understandable.

The intended experience begins in a local terminal. A developer gives Tesota a
goal in ordinary language; naming files is optional. Tesota should first discover
and show the proposed scope and checks without changing the repository, then ask
for one task-sized approval before bounded execution. The developer follows its
progress and receives a diff with the checks that apply to it. The developer
should be able to see what changed, what was verified and what still needs
judgment without reconstructing a conversation or trusting a model's declaration
of success. The proposed contract is recorded in
[decision 003](decisions/003-natural-language-task-experience.md).

The intended normal entry point is **Tesota Shell**, the interactive terminal
experience opened by running `tesota` in the current repository. It begins as a
thin inline conversation and should become a focused persistent TUI before Tesota
broadens into general repository execution. Lifecycle subcommands remain available
as composable and diagnostic seams, but the developer should not need to copy
identifiers or drive each internal transition to complete an ordinary task.

Tesota is cross-surface by contract and TUI-first by product. Task authority,
lifecycle validity and evidence meaning belong to the application rather than its
renderer, so changing presentation cannot change what an action is allowed to do.
Tesota Shell is the only interactive product surface currently planned. This
principle does not commit the project to a GUI, web application, IDE extension,
remote protocol or parity work for surfaces without a demonstrated consumer.

## Why the name

The name is drawn from *Olneya tesota*, desert ironwood, also known as *palo fierro*.
This Sonoran Desert tree has dense, durable wood and provides shelter that helps
other plants establish themselves. The botanical reference is described by the
[Arizona-Sonora Desert Museum](https://www.desertmuseum.org/programs/ifnm_ironwoodtree.php).

For the project, that suggests a durable foundation that supports growth. This
is the intended meaning of the name, not a literal translation or a claim that
the software has already achieved that dependability.

Use **Tesota** as the product name and `tesota` for its package and command
identity. Keep ordinary engineering terms in code: tasks, tools, verification and
evidence. The tree explains the name; it does not supply an architecture vocabulary.

## What it aims to become

Tesota aims to support a repeatable development cycle in which:

- Work stays within the requested scope, with visible progress and interruptions.
- Verification is part of implementation, and detected failures lead to correction.
- Evidence refers to the code actually checked; later edits do not inherit an old pass.
- The result makes its changes, checks, observed consumption and limitations clear.
- Human acceptance remains a separate decision from model completion or passing checks.

Its first proving ground is Tesota itself: a known usable version should help
produce a small improvement to the next version, verify it and present it for
acceptance. This is a concrete way to test the development cycle. The broader
purpose is helping developers build and maintain software.

Growth should follow actual use. A new capability earns its place by solving an
observed problem while preserving the usable development cycle. The first measure
of success is an accepted change supported by applicable evidence, with the
required human intervention, elapsed time and observed consumption made visible.
Feature count alone does not establish usefulness.

## Its relationship to Kiln and Pi

Tesota carries forward the original ambition to use an agent to help develop
itself. [Kiln](references/kiln.md) supplies history, lessons and selected reference
implementations. The [reconstruction decision](decisions/001-start-tesota.md)
explains why work moved to a smaller incremental foundation.

Pi supplies engine capabilities behind an integration boundary. Tesota owns the
development experience and the meaning of its verification, evidence and task
acceptance. Its identity is independent of the engine or model selected for an
experiment. The [Pi decision](decisions/002-use-pi.md) records the current technical
choice and its limits.
