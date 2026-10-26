import { expect, it } from "vitest";
import { terminalText } from "../src/terminal-text.js";

it("keeps visible words and line structure while replacing terminal controls", () => {
  const controls = Array.from({ length: 160 }, (_, code) => code)
    .filter((code) => code < 32 || code >= 127).map((code) => String.fromCharCode(code)).join("");
  expect(terminalText(controls).replaceAll("\n", "").replaceAll("\t", "")).not.toMatch(/\p{Cc}/u);
  expect(terminalText("a\r\nb\rc\td\n\x1b[31me\x1b[0m\b\x07")).toBe("a\nb\nc\td\ne��");
});
