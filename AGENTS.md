# Tesota

This private package is the M1 bootstrap: compiled CLI help and development
checks. It is not yet an agent. Keep changes scoped to the active increment.

- Historical provenance is `4257ee9fce034cfe8e50dce3dbe3afb12f468094`;
  it is not a verified functional baseline.
- Read README.md for supported tooling and commands.
- Run `bun run check` for source, tests, compiled CLI behavior, and lint.
- Preserve LICENSE, NOTICE, and retained third-party notices.
- Keep one owner per behavior; introduce modules only for implemented consumers.
- Keep credentials, operator state, provider routing, and execution permissions
  out of instruction Markdown. This scaffold has no provider integration.
- Do not inherit the Kiln roadmap or write state into its private namespace.
- Later verification must distinguish check evidence from human acceptance.
