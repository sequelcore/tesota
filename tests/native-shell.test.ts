import { expect, it, vi } from "vitest";
import { runNativeShell } from "../src/native-shell.js";

it("starts a Tesota-owned conversation and sends the natural-language request to discovery", async () => {
  const output: string[] = [];
  const propose = vi.fn(async () => 0);

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async (prompt) => {
      output.push(prompt);
      return "  Corrige la experiencia del shell.  ";
    },
    propose,
  });

  expect(result).toBe(0);
  expect(propose).toHaveBeenCalledOnce();
  expect(propose).toHaveBeenCalledWith("Corrige la experiencia del shell.");
  expect(output.join("")).toBe(
    "Tesota\n" +
    "Repository: C:\\work\\tesota\n" +
    "Describe the change you want. File names are optional.\n\n" +
    "> \n" +
    "Discovering scope and checks. Nothing will be changed.\n\n" +
    "Proposal ready. Execution from this session is not available yet.\n",
  );
});

it("ends without inference when the operator enters no request", async () => {
  const output: string[] = [];
  const propose = vi.fn(async () => 0);

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async () => "   ",
    propose,
  });

  expect(result).toBe(0);
  expect(propose).not.toHaveBeenCalled();
  expect(output.at(-1)).toBe("No request entered. Nothing changed.\n");
});

it("reports a blocked proposal without claiming executable progress", async () => {
  const output: string[] = [];

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async () => "Update the docs",
    propose: async () => 1,
  });

  expect(result).toBe(1);
  expect(output.at(-1)).toBe("Proposal blocked or unavailable. Nothing changed.\n");
});
