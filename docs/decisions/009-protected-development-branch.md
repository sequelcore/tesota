# 009: Use a protected development integration branch

Status: adopted.

## Context

The repository transition initially kept `main` as Tesota's only active branch
and froze the former Kiln `dev` branch. The protected
`kiln-legacy-2026-09` tag now preserves that branch's exact final commit, so the
branch name no longer needs to carry historical state.

Tesota's operator wants a durable development integration line in addition to a
stable default branch. A long-lived integration branch is useful only if its
role, promotion path and divergence rules are explicit; otherwise it becomes a
second ambiguous source of truth.

## Decision

`main` is the stable default branch. `dev` is recreated from the current `main`
and becomes Tesota's protected integration branch. The Kiln tag remains
immutable and is not moved when either active branch advances.

Ordinary work starts on a short-lived branch from `dev` and returns through a
pull request to `dev`. Integrated increments move from `dev` to `main` through a
pull request using a merge commit, preserving the ancestry of the long-lived
branch. A hotfix starts from `main`; after it is accepted into `main`, `main` is
merged back into `dev` promptly.

Both branches require the Ubuntu and Windows repository checks, an up-to-date
pull request and resolved review conversations. Protections apply to
administrators and prohibit force pushes and deletion. The required approval
count remains zero while the project has no guaranteed independent reviewer;
the pull-request boundary and automated checks remain mandatory.

Merge commits remain available because they express promotion between the two
long-lived branches. Linear-history enforcement is therefore disabled on both
branches. Short-lived branches are deleted after merge; the protected `dev`
branch is retained.

## Consequences

`dev` may be ahead of `main` while an increment is being integrated. They are
expected to match when a release promotion has settled, except for the explicit
merge commit on `main`. Changes made first on `main` are incomplete until they
have been reintegrated into `dev`.

The repository has one stable line and one integration line, not two competing
release branches. CI observes pushes and pull requests for both. Historical
Kiln inspection always resolves the protected tag or its exact commit, never
the active `dev` branch.
