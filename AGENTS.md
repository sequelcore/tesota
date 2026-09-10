# Tesota

This private package provides a CLI, development checks, bounded Oxlint
verification, durable evidence recovery, independent candidate checkouts and
one scoped documentation task with bounded live execution and local review decisions.
Separate Pi compatibility and live
authentication, fixed verification-tool and isolated candidate-correction experiments
exist; it does not yet execute general repository tasks.
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
