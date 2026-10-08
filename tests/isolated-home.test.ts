import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_MODELS_FILE, DEFAULT_ROUTES_FILE } from "../src/model-roles.js";

it("runs every test in a home folder of its own, never the operator's", () => {
  const operator: unknown = JSON.parse(process.env["TESOTA_TEST_OPERATOR_HOME"] ?? "{}");
  expect(dirname(homedir())).toBe(tmpdir());
  expect(homedir()).not.toBe(typeof operator === "object" && operator !== null ? Reflect.get(operator, "USERPROFILE") : undefined);
  expect(homedir()).not.toBe(typeof operator === "object" && operator !== null ? Reflect.get(operator, "HOME") : undefined);
  for (const path of [DEFAULT_ROUTES_FILE, DEFAULT_MODELS_FILE]) expect(path.startsWith(homedir())).toBe(true);
});
