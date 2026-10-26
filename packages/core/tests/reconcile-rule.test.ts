import { expect, test } from "bun:test";
import { repairs } from "../src/reconcile-rule.ts";

const cases: readonly [boolean, boolean, boolean, boolean, number][] = [
  [false, false, false, false, 2],
  [false, false, false, true, 2],
  [false, false, true, false, 0],
  [false, false, true, true, 0],
  [false, true, false, false, 1],
  [false, true, false, true, 3],
  [false, true, true, false, 0],
  [false, true, true, true, 0],
  [true, false, false, false, 0],
  [true, false, false, true, 0],
  [true, false, true, false, 0],
  [true, false, true, true, 0],
  [true, true, false, false, 0],
  [true, true, false, true, 0],
  [true, true, true, false, 0],
  [true, true, true, true, 0],
];

for (const [seen, intended, repaired, readOnly, expected] of cases) {
  test(`seen ${seen}, intended ${intended}, repaired ${repaired}, readOnly ${readOnly}`, () => {
    expect(repairs([seen], [intended], [repaired], [readOnly])).toEqual([expected]);
  });
}

test("each call of a reply gets its own repair", () => {
  expect(repairs([false, false, false, true], [true, true, false, true], [false, false, false, false], [true, false, true, false]))
    .toEqual([3, 1, 2, 0]);
});

test("an empty reply needs no repairs", () => {
  expect(repairs([], [], [], [])).toEqual([]);
});
