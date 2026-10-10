# Tesota

Pre-release verification layer for coding agents, shipped as a Pi package and
a `tesota` command that opens Pi with it: it makes the agent show evidence
that its change does what was asked, proved where it can, tested where it
cannot, and says what it could not verify. It verifies results, not actions.
It builds verification and composes the rest: it adds to the harness through
Pi's public extension points and may carry or recommend existing packages,
but does not rebuild what Pi or an existing package already provides, such
as a sandbox, a session engine, model routes or search.
Keep changes scoped to the active roadmap item.

- Historical provenance is `4257ee9fce034cfe8e50dce3dbe3afb12f468094`;
  it is not a verified functional baseline.
- Read README.md for supported tooling and commands.
- Read docs/roadmap.md for purpose and current scope.
- Follow docs/development.md for documentation placement and verification.
- Run `bun run check` for source, tests, compiled launcher behavior, and lint.
- Preserve LICENSE, NOTICE, and retained third-party notices.
- Keep one owner per behavior; introduce modules only for implemented consumers.
- Give new or changed pure decision and calculation functions whose rule can be
  stated precisely, such as permission and budget checks, LemmaScript `//@`
  specifications taken from the requirement, and prove them with `lsc check
  --backend=dafny` (see `src/verification/check-origin-rule.ts`).
- Keep credentials, operator state, provider routing, and execution permissions
  out of instruction Markdown. Technical integration contracts belong in docs;
  effective restrictions belong in code and configuration.
- Do not inherit the Kiln roadmap or write state into its private namespace.
- Later verification must distinguish check evidence from human acceptance.
