# Budget limits and their evidence

The limits in [budgets.json](budgets.json), and the measurements they came
from. The owner approves each change to them.

## Against the base

The check builds the commit a change is made on and measures it beside the
change, in 7 alternating rounds on the same runner (`scripts/budget.ts`).
A time in `versusBase` fails when the change's median is more than 1.25
times the base's, in both of two attempts. The same rule as for any limit
(`src/budget-rule.ts`) is applied to the ratio.

The tolerance comes from A/A runs: [#819](https://github.com/sequelcore/tesota/pull/819)
changes no engine code, so every budget job on it compares two identical
engines. Change/base ratios, from that pull request's CI run
42142550434 rerun to 8 attempts (each job counted once), and 3 local runs:

| Platform | Samples | Startup | Loop | Resume | First frame |
| --- | --- | --- | --- | --- | --- |
| Ubuntu, CI | 4 | 0.92–1.05 | 0.99–1.00 | 0.99–1.01 | 0.99–1.01 |
| Windows, CI | 5 | 0.91–1.01 | 0.85–1.02 | 0.91–1.08 | 0.94–1.01 |
| Windows, local | 3 | 0.95–1.01 | 0.91–1.05 | 1.02–1.08 | 0.97–1.02 |

The widest drift between identical code was 15%, the Windows loop at
0.85. The same Windows loop measured 139 to 459 ms in absolute terms on
unchanged code between 11-01 and 11-06, so the ratio removes most of the
runner's variance. A slowdown of more than 25% in one of these four times
fails. Twelve samples are few: if the drift proves wider on CI, that
measurement's tolerance is revised from new A/A runs, not guessed.

## Absolute limits

Size, memory and the count of syncs vary little between runs and keep
exact limits. The times keep backstops, so slowdowns too small to fail one
change can't add up unnoticed across many. Each backstop is at least 1.5
times the largest value CI measured on `dev` and its pull requests between
11-01 and 11-06: the budget line of every engine shard 1 job in the last
200 CI runs, 58 attempts on Windows and 54 on Linux. No limit was
tightened.

| Platform | Measurement | Largest measured | Limit |
| --- | --- | --- | --- |
| Windows | loop | 458.9 ms | 690 ms |
| Windows | base | 505.5 ms | 760 ms |
| Windows | settle | 1.15 ms | 1.75 ms |
| Windows | first frame | 237.1 ms | 360 ms |
| Linux | startup | 6.3 ms | 10 ms |
| Linux | base | 24.1 ms | 37 ms |
| Linux | resume | 16.9 ms | 26 ms |
| Linux | first frame | 145.8 ms | 220 ms |

The other limits were already above 1.5 times their largest measurement
and stay as they were. The ratios to startup and to resume, which stood in
for a base before there was one, are removed.
