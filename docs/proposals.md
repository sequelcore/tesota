# Task proposals

Repository discovery gives the model a bounded, read-only view of a committed
baseline. The explicit `task propose` command requires a concise proposed outcome,
read/write set and declarative check selection. The interactive `tesota` shell uses
the same boundary but accepts three results: an answer grounded in observed files,
one necessary clarification question or a task proposal. None creates a candidate,
edits files, executes repository code, approves work or creates a run grant.

## Use

After the [saved Codex login](authentication.md), build Tesota and run it from
the Tesota repository root:

```sh
bun start
bun start task propose "Clarify the task recovery documentation"
```

With no arguments in an interactive terminal, Tesota asks for one message and
routes it through repository discovery. A question prints an answer and its observed
evidence files. Material ambiguity prints one question and stops; the current shell
does not yet continue the conversation. A requested change prints its objective,
proposed files, completion conditions, check names, exact committed baseline and
retained proposal directory. The explicit subcommand accepts a request directly,
requires the proposal result and remains useful for automation and diagnosis. File
names are optional hints, not required syntax.
`ready for review` means only that discovery produced a structurally admitted
proposal. It does not mean the proposal is correct, accepted or executable.

The current command is intentionally limited to Tesota's own repository and the
stored Codex model route. Provider inference is reported as configured transport;
the model receives no shell, edit, check, web or arbitrary network tool.

## Discovery boundary

Tesota reads the named Git `HEAD` commit through fixed local Git operations. The
model can list allowed paths, search literal text, read an allowed regular UTF-8
blob and submit one parsed result. Application-owned schemas and budgets limit each
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

Only a completed task-proposal result exclusively creates
`~/.tesota/proposals/<uuid>/proposal.json` with private permissions. The strict
version 1 record binds the request, committed baseline, model identity, observed
budgets, dirty paths and the submitted proposal. Its authority is explicitly
`none`, its provenance is `model_proposed`, and its check entry is declarative and
non-executable. Answers, clarification, failed or unsettled discovery retain no
proposal record.

There is deliberately no record reader or `task start` consumer yet. Editing a
proposal file therefore cannot grant file, check, network, candidate, acceptance
or promotion authority. The [natural-language task decision](decisions/003-natural-language-task-experience.md)
defines the later admission boundary that must exist before execution is added.

Exit 0 reports a completed answer, clarification or proposal ready for review.
Exit 1 reports a blocked proposal or failed discovery. Invalid or unsupported live
platform use exits 2 where detected before discovery. Normal repository checks use
fake provider streams and never invoke live inference.

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

After the implementation commits left the repository clean, a second stored-OAuth
run completed against baseline `9f9031e68464d82ecab02e3a7f22352381f5c0e2`.
The same Spanish outcome-only request selected `docs/verification.md` without a
file hint and returned `ready` through five model invocations, ten bounded tool
calls and ten admitted operations. The private record retained `authority: "none"`
and the repository remained unchanged. This qualifies the clean proposal path;
it still does not establish proposal correctness, acceptance or execution.
