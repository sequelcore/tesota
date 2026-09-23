# Tesota

This pre-release package provides a CLI, development checks, bounded Oxlint
verification, durable task-outcome recovery, independent candidate checkouts and
one approved contained repository typecheck profile, one proposal-backed
TypeScript source task with bounded execution, local review
decisions and guarded exact-file promotion.
Separate live authentication and historical Pi compatibility, fixed
verification-tool and isolated candidate-correction experiments are documented.
The bounded source-task flow has Windows/Docker live qualification;
this does not establish general repository-task support or cross-platform live qualification.
Keep changes scoped to the active increment.

- Historical provenance is `4257ee9fce034cfe8e50dce3dbe3afb12f468094`;
  it is not a verified functional baseline.
- Read README.md for supported tooling and commands.
- Read docs/identity.md for product identity, purpose and naming.
- Read docs/architecture.md for ownership and docs/roadmap.md for current scope.
- Follow docs/development.md for documentation placement and verification.
- Run `bun run check` for source, tests, compiled CLI behavior, and lint.
- Preserve LICENSE, NOTICE, and retained third-party notices.
- Keep one owner per behavior; introduce modules only for implemented consumers.
- Keep credentials, operator state, provider routing, and execution permissions
  out of instruction Markdown. Technical integration contracts belong in docs;
  effective restrictions belong in code and configuration.
- Do not inherit the Kiln roadmap or write state into its private namespace.
- Later verification must distinguish check evidence from human acceptance.
