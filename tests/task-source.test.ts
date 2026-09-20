import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { taskSourceInputsSchema, validateTaskSourceInputs } from "../src/task-source.js";

const path = "src/value.ts";
const baseline = "export const value = 1;\nexport const other = 2;\n";
function inputs(content: string) {
  return { [path]: { sha256: createHash("sha256").update(content).digest("hex"), mode: 0o644 } };
}

it.each([baseline, baseline.replaceAll("\n", "\r\n")])("admits a complete baseline representation: %j", (content) => {
  expect(() => validateTaskSourceInputs(inputs(content), [path], { [path]: baseline })).not.toThrow();
});

it.each([baseline.replace("\n", "\r\n"), baseline.replace("1", "3"), baseline + "\n"])(
  "rejects mixed endings and substantive source differences: %j", (content) => {
    expect(() => validateTaskSourceInputs(inputs(content), [path], { [path]: baseline }))
      .toThrow("Task source binding invalid");
  });

it("requires exactly the admitted source targets and bounded metadata", () => {
  expect(() => validateTaskSourceInputs({}, [path], { [path]: baseline })).toThrow();
  expect(() => validateTaskSourceInputs({ ...inputs(baseline), extra: { sha256: "a".repeat(64), mode: 0o644 } },
    [path], { [path]: baseline })).toThrow();
  expect(taskSourceInputsSchema.safeParse({ [path]: { sha256: "bad", mode: 0o644 } }).success).toBe(false);
  expect(taskSourceInputsSchema.safeParse({ [path]: { ...inputs(baseline)[path], mode: 0o100644 } }).success).toBe(false);
  expect(taskSourceInputsSchema.safeParse({ [path]: { ...inputs(baseline)[path], permission: true } }).success).toBe(false);
});
