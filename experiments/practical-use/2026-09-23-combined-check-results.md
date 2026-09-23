# Combined-check task attempt, 2026-09-23

## Question and setup

Could an ordinary Tesota shell session select both the targeted Node regression
test and contained TypeScript typecheck before approval, then finish a source
and test repair with evidence for the same result?

This was an **internal diagnostic**, not an external-repository usefulness
trial. The source was a clean local clone of Tesota at `6ec4646f`, with one
native Node test committed as fixture baseline `cbe6480bed5572fb77b9ec59493b891b49a06c02`.
The clone used the existing TypeScript declaration, Linux/x64 dependency
installation and Docker check profiles. The selected files were
`src/verification/invocation-admission.ts` and
`tests/invocation-admission-node.test.ts`. The task asked for denial of
non-finite numeric inputs while preserving finite behavior. No file outside
those two was admitted for editing.

## Observation

The shell showed both checks as eligible. The operator selected the combined
option (`2`) and approved the resulting scope (`y`). Tesota made two candidate
edits. Its first check found no changed file; its second observed the new
regression failing against the original source (one pass, one fail). A separate
clean baseline with only the candidate test reproduced that failure; the
candidate source and test passed the targeted Node command directly (two
passes). The regression therefore detected the original behavior in this
case. These direct commands were diagnostic and did not authorize application.

The model session reached its 300-second limit after seven model invocations
and seven tool calls. `attempt.jsonl` records `outcome: unsettled`,
`settlement: unconfirmed`, two observed checks and `current: null`. The shell
reported execution settlement as unconfirmed. There was no final Tesota check
of both profiles, no review prompt, no human acceptance and no application.
The candidate and its failed record remain under local Tesota state; the
original repository clone was not changed by promotion.

Independent Astra review identified a separate candidate defect:
`Number.isFinite` in the proposed repair is unsupported by the repository's
retained LemmaScript/Dafny check for this function. A read-only `lsc info
--typed --backend=dafny` inspection reported an unsupported `.isFinite()`
method call. The candidate cannot be called repository-ready on its Node test
alone. The same review found an approval-scope substitution risk and a missing
verifier-input binding in Tesota; those implementation findings were addressed
in source and regression tests after this attempt. This record does not turn
the unsuccessful live attempt into a pass.

After the implementation fix, a read-only preparation diagnostic in this clone
found both adapters eligible and confirmed that each prepared profile's input
identity matched its eligibility preview. It did not execute the verifiers or
settle the earlier task.

## Claim and next qualification

The attempt demonstrates that the ordinary shell can preview eligibility,
select both checks and obtain a failing regression observation. It does **not**
establish a completed combined-check task, safe acceptance or application. A
fresh task must preserve the target repository's other verification contracts,
finish with confirmed Node and TypeScript results on the exact candidate,
reach independent review and an explicit human decision, and record operator
effort and remaining defects. The fixture was created for this diagnostic, so
an external task is still needed to assess usefulness.
