import { expect, it, vi } from "vitest";
import { askNativeShellRequest, runNativeShell } from "../src/native-shell.js";

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

it("releases readline before discovery so process interruption reaches the proposal owner", async () => {
  const events: string[] = [];
  const terminal = {
    question: vi.fn(async (_prompt: string, _options?: { readonly signal?: AbortSignal }) => {
      events.push("question");
      return "Update the docs";
    }),
    once: vi.fn((_event: "SIGINT", _listener: () => void) => terminal),
    removeListener: vi.fn((_event: "SIGINT", _listener: () => void) => terminal),
    close: vi.fn(() => { events.push("close"); }),
  };

  await expect(askNativeShellRequest(terminal, "> ")).resolves.toBe("Update the docs");
  expect(events).toEqual(["question", "close"]);
  expect(terminal.removeListener).toHaveBeenCalledOnce();
});

it("aborts and closes the pending question when readline receives Ctrl+C", async () => {
  let interrupt: (() => void) | undefined;
  const terminal = {
    question: vi.fn(async (_prompt: string, options?: { readonly signal?: AbortSignal }) =>
      new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      })),
    once: vi.fn((_event: "SIGINT", listener: () => void) => { interrupt = listener; return terminal; }),
    removeListener: vi.fn((_event: "SIGINT", _listener: () => void) => terminal),
    close: vi.fn(),
  };

  const pending = askNativeShellRequest(terminal, "> ");
  expect(interrupt).toBeDefined();
  interrupt?.();

  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(terminal.close).toHaveBeenCalledOnce();
});
