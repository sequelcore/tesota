# Linux loop budget

The loop is limited to 14 times the same attempt's resume, with a 240 ms
absolute backstop. Both attempts must exceed a limit to fail. The owner
approved these limits on 2026-11-01 for
[#783](https://github.com/sequelcore/tesota/issues/783).

## Evidence

First-attempt logs from the latest 40 CI runs yielded 48 Linux measurements,
including each budget's internal retry. The current measured path, from
run 41095288991 onward, had 25 measurements across 17 runs. Its loop/resume
ratios ranged from 10.377 to 13.225. All pass the new limits; all reject
a simulated 50% loop-only slowdown. This replay selected the limits. It is
not a held-out check or evidence of future runner stability.

Representative first attempts, including the budget's internal retry:

| CI run | Loop, ms | Resume, ms | Loop/resume |
| --- | --- | --- | --- |
| [41095288991](https://github.com/sequelcore/tesota/actions/runs/41095288991) | 131.8, 126.3 | 10.9, 11.5 | 12.092, 10.983 |
| [41127736709](https://github.com/sequelcore/tesota/actions/runs/41127736709) | 120.4, 121.9 | 10.2, 11.3 | 11.804, 10.788 |
| [41131604704](https://github.com/sequelcore/tesota/actions/runs/41131604704) | 147.7, 154.8 | 12.5, 11.9 | 11.816, 13.008 |
| [41137648288](https://github.com/sequelcore/tesota/actions/runs/41137648288) | 124.7, 124.5 | 10.2, 10.1 | 12.225, 12.327 |
| [41255446876](https://github.com/sequelcore/tesota/actions/runs/41255446876) | 128.4, 132.3 | 11.1, 11.1 | 11.568, 11.919 |
| [41138682660](https://github.com/sequelcore/tesota/actions/runs/41138682660) | 79.9 | 7.7 | 10.377 |
| [41118122175](https://github.com/sequelcore/tesota/actions/runs/41118122175) | 93.9 | 7.1 | 13.225 |

Reproduce the inputs with `gh run view <id> --attempt 1 --log`, taking each
`Budget on linux:` line. `tests/budget.test.ts` retains two false failures,
their simulated regressions and the absolute backstop as regression cases.

Resume controls shared runner speed; the absolute loop and resume limits
guard slowdowns shared by both. Their different workloads and filesystem
costs remain limits of the comparison. New CI runs must still demonstrate
stability.

A compiled Linux diagnostic under WSL ran the same 50-round scripted session,
with a delay around each real tool call in the slower arm. Three alternating
pairs after warm-up measured median loop/resume ratios of 12.06 normally and
21.24 with the delay. The actual median loop slowdown was 61%, from 125.5 to
201.8 ms. The new ratio rejects that slowdown below the absolute backstop.
This small local experiment supports regression sensitivity; it does not
establish CI stability or a precise 50% detection threshold.
