import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A nested checkout has its own suite; this checkout's scripts own these tests and their groups.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/isolated-home.ts"],
  },
});
