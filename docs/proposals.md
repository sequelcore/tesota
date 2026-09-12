# Task proposals

Repository discovery gives the model a bounded, read-only view of a committed
baseline. The explicit `task propose` command requires a concise proposed outcome,
read/write set and declarative check selection. The interactive `tesota` shell uses
the same boundary but accepts three results: an answer grounded in observed files,
one necessary clarification question or a task proposal. Discovery itself never
creates a candidate, edits files, executes repository code, approves work or
creates a run grant. A separate admitted start may follow.

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

Editing a proposal file cannot grant file, check, network, candidate, acceptance
or promotion authority. The record reader treats JSON as untrusted evidence.
`task start` issues an in-memory grant only after the current baseline and the
first narrow policy are revalidated and the operator approves the displayed scope.

## Start the first supported task

The first execution slice accepts exactly one existing `.md` write below `docs/`,
at most eight proposed reads including that file, and the declarative
`repository-check`. The proposal must be `ready`, belong to the current repository
and match its current `HEAD`. Other paths, multiple writes, stale baselines and
blocked proposals fail before candidate creation. Read paths are rechecked against
the discovery exclusion policy, so rewriting retained JSON cannot expose `.env`,
credential, secret or private-key paths to candidate inference.

```sh
bun start task start <proposal-id>
```

The argument-free shell calls this seam itself for a supported ready proposal, so
the normal experience does not require copying the ID. Approval creates one
independent candidate and one exclusive `start.jsonl`; any second, concurrent or
resumed start is rejected. Pi receives only bounded read, whole-file replacement
and Tesota-owned scope-check operations. No shell command, candidate program,
repository script or model-controlled network tool is available.

### If the operator declines approval

If the operator declines the first task-start approval, execution does not begin.
No candidate and no `start.jsonl` record are created. The source checkout remains
unchanged, and the retained proposal stays available for later review and a later
start attempt.

The scope check proves only that at least one admitted documentation byte changed
and no out-of-scope path entered the candidate. It explicitly reports that the
declarative repository check is not executed in this slice and cannot prove that
the prose satisfies the request. Tesota prints the diff as an escaped JSON string,
then asks the person to accept or reject those exact reviewed bytes. Acceptance
and passing scope evidence remain separate. An accepted candidate is promoted
only if the source baseline and target bytes still match; a conflict changes no
source file.

Each approval question owns readline only while the person is answering it. Once
scope is approved, readline closes so Ctrl+C reaches the active task cancellation
owner instead of being consumed by the prompt. A cancelled execution returns 130,
retains its candidate evidence and creates no review decision or promotion. Ctrl+C
at either question also grants no new authority.

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

After conversational discovery was implemented, a stored-OAuth shell run on
2026-09-12 UTC asked in Spanish what Ctrl+C does while Tesota waits for input. The
result was an `answer` grounded in `src/native-shell.ts` and
`tests/native-shell.test.ts` at baseline
`1f2326992c9130717945c97f8b477bbb9a696aa4`. It reported authority `none`, changed
no repository files and left the private proposal-directory count unchanged at
three. This qualifies one live answer path, not general intent recognition,
clarification usefulness or answer correctness beyond the inspected example.

The first live proposal-start attempt on 2026-09-12 UTC exposed a prompt defect
without changing source. Proposal `ea1aa560-d6f1-4906-8c9a-ba4b52464b37`
correctly selected `docs/proposals.md` from an outcome-only request and received
scope approval, but Luna attempted replacement before the mandatory initial check.
Tesota denied the operation, retained failed candidate
`b61901b9-e79c-41ab-a14c-a9772cbc7211` with zero edits, and created no decision
or promotion. The executor prompt was then corrected and covered by a test; the
consumed proposal was not replayed or resumed.

A fresh shell run against baseline `8f96f6bfd79c382b2915eb402d70bb618a5f385d`
created proposal `61e2573c-fd42-4425-b210-10dacde06c49` and passed its ID directly
to the approval flow. Candidate `5b83844e-ef91-4e32-80cf-07125fafaf56` completed
through five model invocations, four tool calls, one edit, an initial failed scope
check and a final passing scope check. The escaped diff was inspected, explicitly
accepted and promoted only `docs/proposals.md`. The promoted documentation change
was committed as `571fef2f`; after the final cancellation and sensitive-path
repairs, the complete repository gate passed 22 test files and 302 tests. Two slow
integration cases also received explicit bounded timeouts. This qualifies one
end-to-end documentation lifecycle and its fail-closed correction path, not
general tasks or repository-command execution.
