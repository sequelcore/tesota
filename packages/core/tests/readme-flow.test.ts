import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { flowSvg, flowSvgPath } from "../scripts/readme-flow.ts";

for (const appearance of ["dark", "light"] as const) {
  test(`keeps the README's ${appearance} flow SVG drawn from its Mermaid source`, () => {
    // Regenerate with the screenshots script after changing docs/assets/tesota-flow.mmd or the theme.
    expect(readFileSync(flowSvgPath(appearance), "utf8").replaceAll("\r\n", "\n")).toBe(flowSvg(appearance));
  });
}

test("shows the flow image in the README for both appearances, in place of a Mermaid block", () => {
  const readme = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  expect(readme).toContain('srcset="docs/assets/tesota-flow-light.svg"');
  expect(readme).toContain('src="docs/assets/tesota-flow-dark.svg"');
  expect(readme).not.toContain("```mermaid");
});
