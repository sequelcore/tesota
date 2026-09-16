# 008: Transition the shared repository identity to Tesota

Status: adopted.

## Context

Tesota was reconstructed in the existing Kiln Git history so provenance,
attribution and selected historical references remained inspectable. During the
bootstrap, GitHub still presented the repository as `sequelcore/kiln`, its
default `main` branch contained an obsolete Kiln state, the final substantive
Kiln work remained on `dev`, and Tesota developed on the temporary
`tesota/bootstrap` branch.

Keeping that public shape would make the repository name and default branch
misrepresent the active product. Moving Tesota to a separate repository would
duplicate or fragment the history, issues and reference URLs without creating a
distinct maintenance boundary.

## Decision

The existing repository becomes `sequelcore/tesota`, and `main` is the only
active Tesota development line. Promotion from `tesota/bootstrap` is a normal
fast-forward because the previous `main` is its ancestor; history is not
rewritten.

The final Kiln `dev` commit
`9b604b105fbf3644328e187b862233660280b604` remains available through both the
frozen `dev` branch and the annotated `kiln-legacy-2026-09` tag. Repository
rules prevent accidental updates, deletion and force pushes to these historical
references. Historical version tags remain Kiln records and do not become
Tesota releases.

The temporary `tesota/bootstrap` branch is removed after the new `main` passes
repository checks. The obsolete Kiln `main` needs no separate branch because it
is already an ancestor of both the frozen Kiln line and Tesota.

GitHub issues and other repository records are retained. Historical Kiln issues
may be closed with context, but they are not deleted or silently reclassified as
Tesota commitments. The old repository name is not reused because doing so would
break GitHub's redirect from existing links and Git clients.

## Consequences

The public repository opens on Tesota while preserving inspectable Kiln
provenance. Contributors use `main` for current work and must not treat `dev` as
an integration branch. Local clones should update their remote URL after the
rename even though GitHub redirects ordinary Git operations.

The rename does not preserve calls to a GitHub Action hosted under the old
repository name. Tesota does not publish such an action at this transition; a
future action must use the Tesota repository identity explicitly.
