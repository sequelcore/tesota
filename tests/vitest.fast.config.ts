import { defineConfig, type ViteUserConfig } from "vitest/config";

/**
 * Tests admitted here stay inside the Vitest worker: no Git, compiler, CLI,
 * verifier, provider or other operating-system process is launched.
 * Unclassified tests remain covered by the complete `test` gate.
 */
const configuration: ViteUserConfig = defineConfig({
  test: {
    include: [
      "tests/codex-login.test.ts",
      "tests/tesota-shell-command.test.ts",
      "tests/tesota-shell-terminal.test.ts",
      "tests/tesota-shell.test.ts",
      "tests/test-report.test.ts",
    ],
    maxWorkers: 4,
    testTimeout: 10_000,
  },
});

export default configuration;
