import { expect, test } from "bun:test";
import { type Admission, admitChild, branchGuard, childMode } from "../src/agent-rule.ts";
import { configHooks } from "../src/workspace.ts";

const cases: readonly [string, Parameters<typeof admitChild>, Admission][] = [
  ["the top session starts a child", [0, 2, 0, 4, true, false], "start"],
  ["a child starts its own", [1, 2, 0, 4, false, false], "start"],
  ["a child two below the top starts none", [2, 2, 0, 4, false, false], "too_deep"],
  ["depth is refused before the count", [2, 2, 4, 4, true, true], "too_deep"],
  ["a read-only session starts no writer", [0, 2, 0, 4, true, true], "read_only"],
  ["a read-only session starts a reader", [0, 2, 0, 4, false, true], "start"],
  ["the last free place is taken", [0, 2, 3, 4, false, false], "start"],
  ["no place is left at the limit", [0, 2, 4, 4, false, false], "too_many"],
];

for (const [name, args, expected] of cases) test(name, () => { expect(admitChild(...args)).toBe(expected); });

test("a reader is read only and a writer takes its parent's mode", () => {
  expect(childMode("full", false)).toBe("read");
  expect(childMode("ask", true)).toBe("ask");
  expect(childMode("read", true)).toBe("read");
});

test("a writing child is guarded when Git can and the operator didn't turn it off, and else starts only if they said to warn (#619)", () => {
  expect(branchGuard("require", true)).toBe("guard");
  expect(branchGuard("warn", true)).toBe("guard");
  expect(branchGuard("off", true)).toBe("unguarded");
  expect(branchGuard("require", false)).toBe("refuse");
  expect(branchGuard("warn", false)).toBe("unguarded");
  expect(branchGuard("off", false)).toBe("unguarded");
});

test("Git runs configuration hooks beside a repository's own from 2.54 on (#619)", () => {
  for (const version of ["git version 2.54.0.windows.1", "git version 2.55.1", "git version 2.100.0", "git version 3.0.0"]) {
    expect(configHooks(version)).toBe(true);
  }
  for (const version of ["git version 2.51.0.windows.1", "git version 2.9.5", "git version 1.99.0", ""]) expect(configHooks(version)).toBe(false);
});
