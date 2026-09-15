import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Tests admitted here stay inside the Vitest worker: no Git, compiler, CLI,
 * verifier, provider or other operating-system process is launched.
 * Unclassified tests remain covered by the complete `test` gate.
 */
const configuration: ViteUserConfig = defineConfig({
  test: {
    include: [
      "tests/command-isolation.test.ts",
      "tests/conversation-cancellation.test.ts",
      "tests/gentle-review-host.test.ts",
      "tests/invocation-admission.test.ts",
      "tests/pi-opaque-reviewer.test.ts",
      "tests/pi-review-relay.test.ts",
      "tests/pi-task-evidence.test.ts",
      "tests/repository-typecheck-command.test.ts",
      "tests/task-outcome.test.ts",
      "tests/tesota-shell-command.test.ts",
      "tests/tesota-shell-terminal.test.ts",
      "tests/tesota-shell.test.ts",
    ],
    maxWorkers: 4,
    testTimeout: 10_000,
  },
});

export default configuration;
