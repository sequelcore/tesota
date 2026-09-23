# Fresh external source-and-test task: frozen protocol

Selection date: 2026-09-23. This task was selected from the committed Gentle Pi
source before submission to Tesota. It is separate from the previously used
trailing-divider task. Retain the first ordinary-shell attempt, including a
refusal, failure or rejection, without changing the request or replacing it.

## Task and baseline

- Repository: `Gentleman-Programming/gentle-pi` at
  `5df9590e55b68717ea0cf8760eb9771c1dc9ed2b`, in a new clean local clone.
- Request: "Fix delta parsing so a `### Requirement:` heading in a later
  unrelated top-level section, such as `## Notes`, is not included in the last
  ADDED, MODIFIED, or REMOVED Requirements section. Add a regression test."
- Preselected source and test: `lib/openspec-deltas.ts` and
  `tests/openspec-deltas.test.ts`. Approve only those paths and the fixed
  `scope-integrity` and `node-test-targeted/v1` checks.

## Behavioral oracle and decision

Construct a delta with one ADDED requirement followed by `## Notes` containing
another `### Requirement:` heading. `parseDeltaSpec` must return only the ADDED
requirement. The new regression test must fail on the committed baseline and
pass on the candidate. Existing assertions must remain intact. Review the
exact source and test diff and the current check claims. Accept and apply only
if the result meets this oracle without weakening existing behavior; otherwise
reject or retain the stopped outcome. The user's live-test acceptance authority
applies to a correct reviewed candidate, not to a check result alone.

Record the baseline and setup, support classification, proposal, check and
review evidence, correction, accepted/application state, residual defects,
elapsed and active operator time, and available or unavailable inference cost.
One selected case cannot establish representative usefulness.
