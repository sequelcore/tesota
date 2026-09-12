# Task proposals

`task propose` is Tesota's first natural-language repository discovery surface.
It turns an operator request into a concise proposed outcome, read/write set and
declarative check selection. It does not create a candidate, edit files, execute
repository code, approve work or create a run grant.

## Use

After the [saved Codex login](authentication.md), build Tesota and run it from
the Tesota repository root:

```sh
bun start task propose "Clarify the task recovery documentation"
```

The request is ordinary language. File names are optional hints, not required
syntax. A successful command prints the objective, proposed files, completion
conditions, check names, exact committed baseline and retained proposal directory.
`ready for review` means only that discovery produced a structurally admitted
proposal. It does not mean the proposal is correct, accepted or executable.

The current command is intentionally limited to Tesota's own repository and the
stored Codex model route. Provider inference is reported as configured transport;
the model receives no shell, edit, check, web or arbitrary network tool.

## Discovery boundary

Tesota reads the named Git `HEAD` commit through fixed local Git operations. The
model can list allowed paths, search literal text, read an allowed regular UTF-8
blob and submit one proposal. Application-owned schemas and budgets limit each
operation, file size, scan, returned bytes, tool calls, model continuations and
session settlement. Known credential-like paths and unsupported path shapes are
omitted or denied. Binary, oversized, redirected and non-regular inputs do not
become model context.

Discovery rejects effective Git configuration that could run a clean, process,
external-diff or text-conversion program while inspecting working changes.
Cancellation is observed between bounded blob operations; an in-flight synchronous
Git operation can delay settlement for at most its 60-second subprocess timeout.

The source working tree is observed but never imported into discovery. Tracked,
staged and non-ignored untracked paths are compared with the proposal. A conflict
in a proposed read/write path, test or repository-check configuration changes the
result to `blocked by excluded working changes`; unrelated dirt does not. Tesota
does not commit, stash or overwrite operator work.

## Retained record

Each completed discovery exclusively creates
`~/.tesota/proposals/<uuid>/proposal.json` with private permissions. The strict
version 1 record binds the request, committed baseline, model identity, observed
budgets, dirty paths and the submitted proposal. Its authority is explicitly
`none`, its provenance is `model_proposed`, and its check entry is declarative and
non-executable. Failed or unsettled discovery retains no proposal record.

There is deliberately no record reader or `task start` consumer yet. Editing a
proposal file therefore cannot grant file, check, network, candidate, acceptance
or promotion authority. The [natural-language task decision](decisions/003-natural-language-task-experience.md)
defines the later admission boundary that must exist before execution is added.

Exit 0 reports a proposal ready for review. Exit 1 reports a blocked proposal or
failed discovery. Invalid or unsupported live platform use exits 2 where detected
before discovery. Normal repository checks use fake provider streams and never
invoke live inference.

## Live qualification

The first stored-OAuth run completed on 2026-09-12 UTC against committed baseline
`4d6e33ca96b60e3cba4de53a36b4708aac3ad7a3`. The Spanish request named no files;
the model selected `docs/architecture.md`, supplied two completion conditions and
the declarative `repository-check` through four model invocations and six bounded
tool calls. Tesota reported `blocked_dirty` because the proposed file and immutable
check inputs had excluded working changes. The retained record had
`authority: "none"`; no candidate, repository edit, check execution, acceptance or
promotion occurred. This qualifies discovery and safe dirty-input blocking, not
proposal correctness or executable admission.
