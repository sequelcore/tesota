import { expect, it } from "vitest";
import { terminalOutputText } from "../src/terminal-output.js";

it("keeps what a terminal would show of a command's output: no colors, cursor sequences or redrawn progress", () => {
  const vitest = "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/web-search.test.ts\x1b[2m > \x1b[22msearches\r\n" +
    "\x1b[32m- Expected\x1b[39m\n\x1b]8;;https://vitest.dev\x07docs\x1b]8;;\x07\n";
  expect(terminalOutputText(vitest)).toBe(" FAIL  tests/web-search.test.ts > searches\n- Expected\ndocs\n");
  expect(terminalOutputText("\x1b[?25l 10%\r 50%\r\x1b[K100%\x1b[?25h\ndone")).toBe("100%\ndone");
});

it("leaves other control characters for the display to escape", () => {
  expect(terminalOutputText("bell\x07 and a lone \x1b")).toBe("bell\x07 and a lone \x1b");
});
