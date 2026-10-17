# Tesota

Pre-release coding agent whose every run ends in verification: it makes the
agent show evidence that its change does what was asked, proved where it can,
tested where it cannot, and says what it could not verify. It verifies
results, not actions. `tesota` runs on its own engine, `@tesota/core` on Bun
(`packages/core`), where verification is a mandatory step of every run;
`src/` is the verification layer, written against the contract in
`src/contract.ts`. Model access stays in `pi-ai` and the terminal in
`pi-tui`; it does not build its own sandbox, verifier or surfaces beyond the
terminal shell, and adds no capability without a consumer that exists today.
Keep changes scoped to the issue being worked on.

- Historical provenance is `4257ee9fce034cfe8e50dce3dbe3afb12f468094`;
  it is not a verified functional baseline.
- Read docs/README.md for the map of the documentation, and the page a
  change touches before changing it.
- Read ROADMAP.md for purpose, principles and non-goals.
- Follow docs/development.md for checks, proved rules, budgets and where
  documentation goes.
- Run `bun run check` for source, tests, lint, and the engine's tests and budgets.
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
