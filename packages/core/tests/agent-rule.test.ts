import { expect, test } from "bun:test";
import { type Admission, admitChild, childMode } from "../src/agent-rule.ts";

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
