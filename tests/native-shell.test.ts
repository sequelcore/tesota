import { expect, it, vi } from "vitest";
import { askNativeShellRequest, runNativeShell } from "../src/native-shell.js";

it("starts a Tesota-owned conversation and sends the natural-language request to discovery", async () => {
  const output: string[] = [];
  const discover = vi.fn(async () => 0);

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async (prompt) => {
      output.push(prompt);
      return "  Corrige la experiencia del shell.  ";
    },
    discover,
  });

  expect(result).toBe(0);
  expect(discover).toHaveBeenCalledOnce();
  expect(discover).toHaveBeenCalledWith("Corrige la experiencia del shell.");
  expect(output.join("")).toBe(
    "Tesota\n" +
    "Repository: C:\\work\\tesota\n" +
    "Ask about the repository or describe a change. File names are optional.\n\n" +
    "> \n" +
    "Inspecting the committed repository. Nothing will be changed.\n\n" +
    "Read-only turn complete. No execution authority was created.\n",
  );
});

it("ends without inference when the operator enters no request", async () => {
  const output: string[] = [];
  const discover = vi.fn(async () => 0);

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async () => "   ",
    discover,
  });

  expect(result).toBe(0);
  expect(discover).not.toHaveBeenCalled();
  expect(output.at(-1)).toBe("No request entered. Nothing changed.\n");
});

it("reports a blocked proposal without claiming executable progress", async () => {
  const output: string[] = [];

  const result = await runNativeShell({
    cwd: "C:\\work\\tesota",
    write: (text) => { output.push(text); },
    ask: async () => "Update the docs",
    discover: async () => 1,
  });

  expect(result).toBe(1);
  expect(output.at(-1)).toBe("Request blocked or unavailable. Nothing changed.\n");
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
