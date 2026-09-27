import { expect, it } from "vitest";
import { Semaphore } from "../src/semaphore.js";

it("grants places up to its limit, then in the order they were asked for", async () => {
  const places = new Semaphore(1);
  const signal = new AbortController().signal;
  expect(await places.acquire(signal)).toBe(true);
  const granted: string[] = [];
  const second = places.acquire(signal).then((ok) => { granted.push(`second:${ok}`); });
  const third = places.acquire(signal).then((ok) => { granted.push(`third:${ok}`); });
  await new Promise((settle) => { setTimeout(settle, 5); });
  expect(granted).toEqual([]);
  places.release();
  await second;
  expect(granted).toEqual(["second:true"]);
  places.release();
  await third;
  expect(granted).toEqual(["second:true", "third:true"]);
  places.release();
  // Every place was given back, so the next one is granted at once.
  expect(await places.acquire(signal)).toBe(true);
});

it("refuses a waiter whose signal aborts, and gives its turn to the next", async () => {
  const places = new Semaphore(1);
  expect(await places.acquire(new AbortController().signal)).toBe(true);
  const stop = new AbortController();
  const stopped = places.acquire(stop.signal);
  const next = places.acquire(new AbortController().signal);
  stop.abort();
  expect(await stopped).toBe(false);
  places.release();
  expect(await next).toBe(true);
  const aborted = new AbortController();
  aborted.abort();
  expect(await places.acquire(aborted.signal)).toBe(false);
});
