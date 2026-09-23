# Combined-check shell-progress task: frozen protocol

Selection date: 2026-09-23. Freeze this task before the first ordinary-shell
attempt. Retain that attempt even if it fails. This is an internal diagnostic
with a real Tesota UI defect and a committed Node-native test fixture; it is
not an external-repository usefulness task.

## Baseline and request

- Clean clone: `C:/Proyectos/Sequel/cloned/tesota-combined-shell-progress-live`
  at `8deaad1adf27f52385415a8e33a9df5c44119282`. Its only added fixture is
  `tests/shell-progress-node.test.ts`, committed before the task.
- Request: When the shell waits for approval of a semantic correction, show
  `Waiting for correction approval`. Keep `Waiting for scope approval` for the
  initial proposal and preserve the other stage labels.
- Allow exactly `src/shell-progress.ts` and
  `tests/shell-progress-node.test.ts` for writes. Require scope integrity,
  targeted Node test and contained TypeScript no-emit on the same final
  candidate. No dependency, configuration, formal-proof or other file edits.

## Independent oracle and decision

The agent must add a correction-approval assertion to the existing Node test.
That test must fail on the original source and pass after the source repair;
existing baseline assertions must remain. Compare the two approval operations
and the other stage labels independently. Both selected checks must pass for
the exact candidate presented for review. Review the diff and remaining
unknowns before accepting; reject or retain failure if any requirement is
unmet. An accepted candidate may be applied only through Tesota's guarded
promotion. Do not manually promote a failed or unsettled attempt.

Record setup, check selection, regression red/green, exact-result evidence,
model/tool/elapsed usage, active operator and review effort where observable,
independent residual defects, decision and application. This diagnostic can
qualify this narrow combined-check path only; external task qualification
remains separate.
