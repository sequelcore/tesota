# Task dependency reuse adapter diagnostic

Date: 2026-09-23. This is a local adapter diagnostic, not an ordinary-shell
task or a general usefulness qualification. It used the uncommitted execution
repair on top of `817d0d23`, Windows, Node 24.15.0, Bun 1.4.2, Docker Desktop
Linux daemon 29.8.0, the repository's pinned Node image, and the installed
TypeScript 5.9.3 package from the local LemmaScript clone.

The temporary fixture was a committed repository with one valid TypeScript
source file, a strict `tsconfig.json`, the approved `typecheck` script and an
independent copy of TypeScript in `node_modules`. Tesota created a candidate,
prepared the approved profile, ran a standalone check, then ran the same
issued profile twice with task input retention. The fixture was removed after
both containers reported exit and absence and the task input was released.
All three real Docker checks passed.

| Phase | Elapsed in this run |
| --- | ---: |
| Profile preparation, including input observation | 3.15 s |
| Standalone check with fresh dependency copy | 8.54 s |
| First task check with retained dependency input | 8.46 s |
| Second task check reusing the same input | 6.38 s |
| Release retained input | 0.03 s |

Exactly one task snapshot existed after each task check, with the same name;
none remained after release. The standalone check removed its own snapshot.
This directly exercises content rehash and reuse across real container runs.
The second task check was 2.08 s faster than the standalone check in this one
small fixture. These totals include repeated input observation, Docker startup,
compiler execution and settlement; they do not isolate each component's time
or establish a representative speedup. No model, review, decision or promotion
ran in this diagnostic. Focused tests cover zero verifier calls in those
stages; a timed ordinary-shell task remains needed for the full plan gate.
