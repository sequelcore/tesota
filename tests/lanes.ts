/**
 * The verification layer's test files by what they need, so one lane runs
 * alone with `bun run test --project <lane>`. A file listed in neither
 * lane is in `processes`: it starts real processes such as Git or Bun.
 */
export const lanes = {
  /** Start no process; `tests/no-processes.ts` fails any that tries. */
  pure: [
    "clarification.test.ts",
    "docs-budget.test.ts",
    "editor.test.ts",
    "footer.test.ts",
    "glyphs.test.ts",
    "grammar-source.test.ts",
    "isolated-home.test.ts",
    "lanes.test.ts",
    "messages.test.ts",
    "model-graph-preview.test.ts",
    "model-html-open.test.ts",
    "model-rule.test.ts",
    "mutation-rule.test.ts",
    "operations.test.ts",
    "project-checks.test.ts",
    "projects.test.ts",
    "proof-cover-rule.test.ts",
    "proof-outcome-rule.test.ts",
    "receipt-message.test.ts",
    "receipt-summary.test.ts",
    "request-references.test.ts",
    "select-list.test.ts",
    "standing.test.ts",
    "terminal-text.test.ts",
    "test-report.test.ts",
    "typescript-source.test.ts",
    "verdict-rule.test.ts",
    "welcome-header.test.ts",
    "working-orb.test.ts",
    "workspace.test.ts",
  ],
  /** Run Dafny or TLC. */
  formal: [
    "evaluation-cases.test.ts",
    "lemmascript-verifier.test.ts",
    "model-check.test.ts",
    "model-html.test.ts",
    "model-tool.test.ts",
    "model-view.test.ts",
    "proof-mutation-equivalence.test.ts",
    "proof-mutation-registered.test.ts",
    "proof-mutation-strength.test.ts",
    "prove-tool.test.ts",
  ],
} as const;
