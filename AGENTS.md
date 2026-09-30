# Tesota

Pre-release terminal coding agent: a Pi agent works in the operator's project,
recording each turn, its commands run in a sandbox or with the operator's
approval, and each turn is verified and reviewed; the operator keeps or
reverts it, and a revert never overwrites the operator's own later edits. A
folder of documents, or a second session, works in a separate workspace it
applies from.
Keep changes scoped to the active roadmap item.

- Historical provenance is `4257ee9fce034cfe8e50dce3dbe3afb12f468094`;
  it is not a verified functional baseline.
- Read README.md for supported tooling and commands.
- Read docs/design/overview.md for purpose, design and ownership, and
  docs/roadmap.md for current scope.
- Follow docs/development.md for documentation placement and verification.
- Run `bun run check` for source, tests, compiled CLI behavior, and lint.
- Preserve LICENSE, NOTICE, and retained third-party notices.
- Keep one owner per behavior; introduce modules only for implemented consumers.
- Give new or changed pure decision and calculation functions whose rule can be
  stated precisely, such as permission and budget checks, LemmaScript `//@`
  specifications taken from the requirement, and prove them with `lsc check
  --backend=dafny` (see `src/verification/finding-origin-rule.ts`).
- Keep credentials, operator state, provider routing, and execution permissions
  out of instruction Markdown. Technical integration contracts belong in docs;
  effective restrictions belong in code and configuration.
- Do not inherit the Kiln roadmap or write state into its private namespace.
- Later verification must distinguish check evidence from human acceptance.
