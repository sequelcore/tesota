/**
 * The engine's test files by what they need, so one lane runs alone with
 * `bun run test <lane>`. A file listed in no lane is in `processes`: it
 * starts real processes such as Git, PowerShell or a Tesota binary.
 */
export const lanes = {
  /**
   * Start no process. The root's `tests/no-processes.ts` fails one started
   * through `node:child_process`; it can't catch `Bun.spawn`, so a file that
   * reaches it belongs in another lane.
   */
  pure: [
    "accounts.test.ts",
    "agent-rule.test.ts",
    "branch.test.ts",
    "budget.test.ts",
    "compaction.test.ts",
    "confirmation.test.ts",
    "context-usage.test.ts",
    "credentials.test.ts",
    "dashboard.test.ts",
    "inventory.test.ts",
    "lanes.test.ts",
    "provider-error.test.ts",
    "provider-retry-rule.test.ts",
    "questions.test.ts",
    "readme-flow.test.ts",
    "reconcile-rule.test.ts",
    "roles.test.ts",
    "session-lock.test.ts",
    "settings.test.ts",
    "settle-rule.test.ts",
    "transcript.test.ts",
    "usage-panel.test.ts",
    "usage.test.ts",
    "working-status.test.ts",
  ],
  /** Draw the shell in an emulated terminal. */
  terminal: [
    "app.test.ts",
    "graph-html.test.ts",
    "interface.test.ts",
    "question-form.test.ts",
    "shell.test.ts",
    "sign-in.test.ts",
  ],
  /** Run Dafny. */
  formal: ["binary.test.ts"],
} as const;

export type Lane = keyof typeof lanes | "processes";
