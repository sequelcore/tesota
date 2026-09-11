import { expect, it, vi } from "vitest";
import { OPAQUE_PI_REVIEWER_LIMITS } from "../src/integrations/pi-opaque-reviewer.js";
import { PI_REVIEW_RELAY_ARGUMENTS, runPiReviewRelay } from "../src/pi-review-relay.js";

async function* input(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk);
}

it("relays exact prompt and result bytes for the fixed tool-free process contract", async () => {
  const write = vi.fn();
  const reviewer = vi.fn(async (prompt: Buffer) => {
    expect(prompt).toStrictEqual(Buffer.from("provider prompt"));
    return { stdout: Buffer.from('{"passed":true}'), promptByteLength: prompt.length, stdoutByteLength: 15 };
  });

  await runPiReviewRelay(PI_REVIEW_RELAY_ARGUMENTS, { reviewer, input: input("provider ", "prompt"), write });

  expect(reviewer).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith(Buffer.from('{"passed":true}'));
});

it("rejects changed process arguments before reading or invoking the model", async () => {
  const reviewer = vi.fn();
  let reads = 0;
  const source: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() { reads += 1; yield Buffer.from("provider prompt"); },
  };

  await expect(runPiReviewRelay([...PI_REVIEW_RELAY_ARGUMENTS, "--tools"], {
    reviewer, input: source, write: vi.fn(),
  })).rejects.toThrow("arguments are not admitted");

  expect(reads).toBe(0);
  expect(reviewer).not.toHaveBeenCalled();
});

it("rejects a provider prompt over the existing reviewer byte bound", async () => {
  const reviewer = vi.fn();
  const source: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(OPAQUE_PI_REVIEWER_LIMITS.promptBytes + 1);
    },
  };

  await expect(runPiReviewRelay(PI_REVIEW_RELAY_ARGUMENTS, {
    reviewer, input: source, write: vi.fn(),
  })).rejects.toThrow("prompt exceeds the byte bound");

  expect(reviewer).not.toHaveBeenCalled();
});
