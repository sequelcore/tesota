# Tesota

Instructions for agents contributing to Tesota, a coding agent that ends
every run with a receipt. Keep changes scoped to the issue being worked on.

## Where things are

- `packages/core` is the engine, `@tesota/core` on Bun: the `tesota`
  command, its loop, sessions, permissions and shell. Verification is a
  mandatory step of every run.
- `src/` is the verification layer, written against the contract in
  `src/contract.ts`.
- Model access stays in `pi-ai`, the terminal in `pi-tui` and MCP in
  `pi-mcp`. Tesota builds no sandbox, contains no verifier, and has no
  surface beyond the terminal; a static file it writes for your browser to
  open, with nothing left running, is allowed. A verifier Sequel maintains
  lives in its own package and is adopted as
  [docs/development.md](docs/development.md#adding-a-verifier) says.
- Read [docs/README.md](docs/README.md) for the map of the documentation,
  and the page a change touches before changing it.
- Read [ROADMAP.md](ROADMAP.md) for principles and non-goals.

## Checks and proofs

- Follow [docs/development.md](docs/development.md) for checks, proved
  rules, budgets and where documentation goes.
- Run `bun run check` for types, tests, lint, and the engine's tests and
  budgets; `bun run formal:check` when a proved rule changed; and
  `git diff --check`.
- Give new or changed pure decision and calculation functions whose rule
  can be stated precisely, such as permission and budget checks,
  LemmaScript `//@` specifications taken from the requirement, and prove
  them with `lsc check --backend=dafny` (see
  `src/verification/check-origin-rule.ts`).

## Scope

- Keep one owner per behavior; introduce modules only for implemented
  consumers.
- Add no capability without a consumer that exists today. That rule is for
  capabilities, not structure: until the first stable release, refactor a
  weak structure now instead of keeping it for compatibility, with a check
  that proves behavior didn't change.
- A user's own team and model choices are their configuration, not a
  default, and need no measurement.
- Decide from facts every Git repository has, such as ancestry, refs other
  than the current branch and commit dates. Never assume a remote name, a
  branch name or when people commit: users work in many ways.
- Tesota is a local harness, even on a server. Before adding per-session
  environments, copies or eager setup, check how local harnesses such as
  Claude Code, Codex CLI and Gemini CLI handle the same need.
- Keep credentials, personal state, provider routing and execution
  permissions out of instruction Markdown. Technical integration contracts
  belong in docs; effective restrictions belong in code and configuration.
- Keep check evidence apart from human acceptance.

## Notices

- Preserve `LICENSE`, `NOTICE` and retained third-party notices.
- Add a notice to `NOTICE` for any third-party code a change bundles or
  adapts, with the license text from the dependency itself.
