# Tesota

Pre-release verification layer for coding agents: it makes the agent show
evidence that its change does what was asked, proved where it can, tested
where it cannot, and says what it could not verify. It verifies results, not
actions. It ships today as a Pi package and a `tesota` command that opens Pi
with it. Under the [2026-10-15 decision](docs/decisions/2026-10-15-own-engine.md)
it is building its own engine, `@tesota/core` on Bun, where verification is a
mandatory step of the session lifecycle. The engine's scope is the contract
Tesota uses from Pi; Pi's tests set the target. Model access stays in
`pi-ai`; it does not build its own sandbox, verifier or surfaces beyond the
terminal shell, and adds no capability without a consumer that exists today.
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
