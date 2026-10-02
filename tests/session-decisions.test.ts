import { expect, it } from "vitest";
import { askingDecisions, toolchainQuestion } from "../src/session-decisions.js";

const decided = (files: readonly string[]): string | undefined => toolchainQuestion(files).options[0]?.decided?.text;

it("names what declared the tools, or needs no name", () => {
  expect(decided(["package.json"])).toBe("✓ Installing what `package.json` declares in the sandbox.");
  expect(decided(["a", "b"])).toContain("`a`, `b` declare");
  expect(decided([])).toBe("✓ Installing the declared tools in the sandbox.");
});

async function tip(suggested: readonly string[]): Promise<string | undefined> {
  const written: string[] = [];
  await askingDecisions(async () => "none", async (question) => question.initial, (text) => written.push(text), () => false)
    .checks(suggested);
  return written.find((text) => text.includes("JUnit"));
}

it("titles the toolchain question without an empty name", () => {
  expect(toolchainQuestion([]).title).toBe("The repository's toolchain changed. Install it in the sandbox now?");
  expect(toolchainQuestion(["package.json"]).title).toContain("(`package.json`)");
});

it("gives the JUnit example with the repository's own check, or none", async () => {
  const withCheck = await tip(["npm run test"]);
  expect(withCheck).toBeDefined();
  expect(withCheck).toContain("npm run test => reports/unit.xml");
  expect(withCheck).not.toContain("bun");
  const without = await tip([]);
  expect(without).toBeDefined();
  expect(without).not.toContain("=>  ");
  expect(without).not.toContain("reports/");
  expect(without).not.toContain("bun");
});
