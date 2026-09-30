import { afterEach, expect, it, vi } from "vitest";
import { chooseCliOption } from "../src/cli-choice.js";

const answers = vi.hoisted(() => [] as string[]);
vi.mock("node:readline/promises", () => ({ createInterface: () => ({
  question: async () => answers.shift() ?? "", close: () => {},
}) }));

afterEach(() => { answers.length = 0; vi.restoreAllMocks(); });

it("filters a long list, then selects the visible choice", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  answers.push("option 25", "1");
  const choices = Array.from({ length: 30 }, (_, index) => ({ value: String(index + 1), label: `option ${index + 1}` }));
  expect(await chooseCliOption("Choose", choices)).toBe("25");
  expect(output.mock.calls.map((call) => call[0]).join("")).toContain("Showing first 20 of 30");
});

it("cancels without selecting and reprompts after an invalid number", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  answers.push("9", "");
  expect(await chooseCliOption("Choose", [{ value: "native", label: "native" }])).toBeUndefined();
});
