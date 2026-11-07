import { configDefaults, defineConfig } from "vitest/config";
import { lanes } from "./tests/lanes.js";

const files = (names: readonly string[]) => names.map((name) => `tests/${name}`);

export default defineConfig({
  test: {
    setupFiles: ["tests/isolated-home.ts", "tests/host.ts"],
    // Many tests run Git and child processes; in the parallel suite on Windows one that takes 1.4 s alone took over 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A nested checkout has its own suite; this checkout's scripts own these tests and their groups.
    projects: [
      { extends: true, test: { name: "pure", include: files(lanes.pure), setupFiles: ["tests/no-processes.ts"] } },
      { extends: true, test: { name: "formal", include: files(lanes.formal) } },
      { extends: true, test: { name: "processes", include: ["tests/**/*.test.ts"],
        exclude: [...configDefaults.exclude, ...files(lanes.pure), ...files(lanes.formal)] } },
    ],
  },
});
