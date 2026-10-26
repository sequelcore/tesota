import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A nested checkout has its own suite; this checkout's scripts own these tests and their groups.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/isolated-home.ts", "tests/host.ts"],
    // Many tests run Git and child processes; in the parallel suite on Windows one that takes 1.4 s alone took over 5 s (#420).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
